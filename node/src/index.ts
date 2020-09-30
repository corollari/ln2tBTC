/* global BigInt */
import express from "express";
import cors from "cors";
import {
  authenticatedLndGrpc,
  createHodlInvoice,
  settleHodlInvoice,
  payViaRoutes,
  subscribeToInvoice,
} from "ln-service";
import parseInvoice from "./parseInvoice";
import { contract, ethAddress } from "./contract";
import { ignoreUnrelatedEvents } from "./utils";
import getRoute, { calculateDelay } from "./getRoute";
import { addFees } from "./fees";

const { lnd } = authenticatedLndGrpc({
  cert: "base64 encoded tls.cert",
  macaroon: "base64 encoded admin.macaroon",
  socket: "127.0.0.1:10009",
});
const operatorFees = contract.methods
  .operators(ethAddress)
  .call()
  .then((op) => {
    const linearFee = BigInt(op.linearFee);
    const constantFee = BigInt(op.constantFee);
    return {
      linearFee,
      constantFee,
    };
  });

const app = express();
app.use(cors());
app.listen(8080);

// tBTC -> LN
app.get("/ln2tbtc/lockTime/:invoice", async (req, res) => {
  try {
    const invoice = parseInvoice(req.params.invoice);
    const { timeoutDelta, fee } = await getRoute(lnd, invoice);
    const delay = calculateDelay(timeoutDelta);
    res.send({
      fee,
      delay,
    });
  } catch (e) {
    res.status(400).send({
      error: "Could not process invoice",
    });
  }
});

contract.events.TBTC2LNSwapCreated(
  {},
  ignoreUnrelatedEvents(async (event) => {
    const invoice = parseInvoice(event.returnValues.invoice);
    const { paymentHash, amount, lockTime, userAddress } = event.returnValues;
    // Check matching hash
    if (invoice.id !== paymentHash) {
      return;
    }
    // Check that lockup time is corect
    const { timeoutDelta, fee, route } = await getRoute(lnd, invoice);
    const paymentDelay = BigInt(calculateDelay(timeoutDelta));
    if (BigInt(lockTime) < paymentDelay) {
      throw new Error("lockTime is too low");
    }
    // Check amount
    const { linearFee, constantFee } = await operatorFees;
    const amountLockedInSats = BigInt(amount) / BigInt(10) ** BigInt(10);
    const amountToPay =
      addFees(amountLockedInSats, constantFee, linearFee) + BigInt(fee);
    const { mtokens, tokens, safe_tokens } = invoice;
    if (
      mtokens === undefined &&
      tokens === undefined &&
      safe_tokens === undefined
    ) {
      throw new Error("No amount provided in invoice, user could lose money");
    }
    if (tokens !== undefined) {
      if (BigInt(tokens) > amountToPay) {
        throw new Error("Amount to pay is too large");
      }
    }
    if (mtokens !== undefined) {
      if (BigInt(tokens) > amountToPay * BigInt(1000)) {
        throw new Error("Amount to pay is too large");
      }
    }
    if (safe_tokens !== undefined) {
      if (BigInt(safe_tokens) > amountToPay) {
        throw new Error("Amount to pay is too large");
      }
    }
    // Pay invoice
    const { secret } = await payViaRoutes({
      lnd,
      id: invoice.id,
      routes: [route],
    });
    // Once paid send an eth tx revealing pre-image
    await contract.methods
      .operatorClaimPayment(userAddress, paymentHash, secret)
      .send({
        from: ethAddress,
      });
  })
);

// LN -> tBTC
const generatedInvoices = {} as {
  [userAddress: string]:
    | undefined
    | {
        [paymentHash: string]: string | undefined;
      };
};

function storeInvoice(
  userAddress: string,
  paymentHash: string,
  invoice: string
) {
  if (generatedInvoices[userAddress] === undefined) {
    generatedInvoices[userAddress] = {};
  }
  const userInvoices = generatedInvoices[userAddress]!;
  if (userInvoices[paymentHash] === undefined) {
    userInvoices[paymentHash] = invoice;
  } else {
    throw new Error(
      "An invoice with the same paymentHash has already been created before by the same user"
    );
  }
}

contract.events.LN2TBTCSwapCreated(
  {},
  ignoreUnrelatedEvents(async (event) => {
    const { paymentHash, tBTCAmount, userAddress } = event.returnValues;
    const { linearFee, constantFee } = await operatorFees;
    const satsToReceive = addFees(BigInt(tBTCAmount), constantFee, linearFee);
    // Create new hold invoice with specified paymentHash
    const { request } = await createHodlInvoice({
      lnd,
      id: paymentHash,
      tokens: Number(satsToReceive),
    });
    storeInvoice(userAddress, paymentHash, request);
    // When HTLCs are locked (payment sent) - lock tbtc
    const sub = subscribeToInvoice({
      lnd,
      id: paymentHash,
    });
    let contractCallSubmitted = false;
    sub.on("invoice_updated", async (invoice) => {
      // Only actively held invoices can be settled
      if (invoice.is_held && !contractCallSubmitted) {
        contractCallSubmitted = true;
        await contract.methods
          .operatorLockTBTCForLN2TBTCSwap(userAddress, paymentHash)
          .send({
            from: ethAddress,
          });
      }
    });
  })
);

app.get("/tbtc2ln/invoice/:userAddress/:paymentHash", (req, res) => {
  const { userAddress, paymentHash } = req.params;
  const invoice = generatedInvoices[userAddress]?.[paymentHash];
  if (invoice === undefined) {
    throw new Error("Invoice for this payment has not been generated");
  }
  res.send({
    invoice,
  });
});

contract.events.LN2TBTCPreimageRevealed(
  {},
  ignoreUnrelatedEvents((event) => {
    const { preimage } = event.returnValues;
    // Settle invoice
    settleHodlInvoice({
      lnd,
      secret: preimage,
    });
  })
);
