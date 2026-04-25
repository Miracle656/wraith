const StellarSdk = require('@stellar/stellar-sdk');

function toBase64(scVal) {
    return scVal.toXDR('base64');
}

// Generate valid keypairs
const aliceKeyPair = StellarSdk.Keypair.random();
const bobKeyPair = StellarSdk.Keypair.random();
const contractKeyPair = StellarSdk.Keypair.random();

const aliceAddress = StellarSdk.Address.fromString(aliceKeyPair.publicKey());
const bobAddress = StellarSdk.Address.fromString(bobKeyPair.publicKey());
const contractId = contractKeyPair.publicKey().replace('G', 'C'); // Simplified contract ID representation

function makeTransferEvent() {
    const topics = [
        StellarSdk.nativeToScVal('transfer', { type: 'symbol' }),
        aliceAddress.toScVal(),
        bobAddress.toScVal()
    ];
    const value = StellarSdk.nativeToScVal(1000000000n, { type: 'i128' });
    return {
        topic: topics.map(toBase64),
        value: toBase64(value)
    };
}

function makeMintEvent() {
    const topics = [
        StellarSdk.nativeToScVal('mint', { type: 'symbol' }),
        aliceAddress.toScVal(), // admin
        bobAddress.toScVal()    // to
    ];
    const value = StellarSdk.nativeToScVal(5000000000n, { type: 'i128' });
    return {
        topic: topics.map(toBase64),
        value: toBase64(value)
    };
}

function makeBurnEvent() {
    const topics = [
        StellarSdk.nativeToScVal('burn', { type: 'symbol' }),
        aliceAddress.toScVal()
    ];
    const value = StellarSdk.nativeToScVal(100n, { type: 'i128' });
    return {
        topic: topics.map(toBase64),
        value: toBase64(value)
    };
}

function makeClawbackEvent() {
    const topics = [
        StellarSdk.nativeToScVal('clawback', { type: 'symbol' }),
        aliceAddress.toScVal()
    ];
    const value = StellarSdk.nativeToScVal(200n, { type: 'i128' });
    return {
        topic: topics.map(toBase64),
        value: toBase64(value)
    };
}

const events = {
    transfer: makeTransferEvent(),
    mint: makeMintEvent(),
    burn: makeBurnEvent(),
    clawback: makeClawbackEvent(),
    alice: aliceKeyPair.publicKey(),
    bob: bobKeyPair.publicKey(),
    contractId: contractId
};

console.log(JSON.stringify(events, null, 2));
