import { randomBytes } from "node:crypto";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/addresses";
import bs58 from "bs58";
import { z } from "zod";
import { boundedJson } from "../../../packages/observability/http.ts";
import { signatureSchema } from "../../../packages/frontend-contracts/founder-village-members/index.ts";
import { checkout, type Order } from "./store.ts";

// Both fields are public identifiers. `genesis` is the Solana network hash,
// and `mint` is Circle's published USDC token mint address for that network.
const cluster = {
  "mainnet-beta": {
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  devnet: {
    genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
} as const;
const systemProgram = "11111111111111111111111111111111";
const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgram = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const encodeAddress = getAddressEncoder();

const tokenBalance = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string().optional(),
  programId: z.string().optional(),
  uiTokenAmount: z.object({
    amount: z.string().regex(/^\d{1,20}$/),
    decimals: z.literal(6),
  }),
});
const transactionSchema = z.object({
  blockTime: z.number().int(),
  transaction: z.object({
    signatures: z.array(signatureSchema),
    message: z.object({
      accountKeys: z.array(z.string()),
      instructions: z.array(
        z.object({
          programIdIndex: z.number().int().nonnegative(),
          accounts: z.array(z.number().int().nonnegative()),
          data: z.string(),
        }),
      ),
    }),
  }),
  meta: z.object({
    err: z.null(),
    preBalances: z.array(z.number().int().nonnegative()),
    postBalances: z.array(z.number().int().nonnegative()),
    preTokenBalances: z.array(z.unknown()).optional(),
    postTokenBalances: z.array(z.unknown()).optional(),
    loadedAddresses: z
      .object({ writable: z.array(z.string()), readonly: z.array(z.string()) })
      .optional(),
  }),
});

export function newReference() {
  return bs58.encode(randomBytes(32));
}

function network(order: Order): keyof typeof cluster {
  return order.test ? "devnet" : "mainnet-beta";
}

export function solanaAction(order: Order) {
  const chain = network(order);
  const url = new URL(`solana:${order.recipient}`);
  url.searchParams.set("amount", checkout(order).amount);
  url.searchParams.set("reference", order.reference!);
  url.searchParams.set("label", "Founder Village");
  if (order.method === "usdc")
    url.searchParams.set("spl-token", cluster[chain].mint);
  return { kind: "solana" as const, network: chain, url: url.href };
}

export async function matchesTransfer(
  order: Order,
  signature: string,
  value: unknown,
): Promise<boolean> {
  const parsed = transactionSchema.safeParse(value);
  if (!parsed.success || !order.recipient || !order.reference) return false;
  const { transaction, meta, blockTime } = parsed.data;
  // Block time is approximate. A reference cannot be known before the order exists.
  if (
    transaction.signatures[0] !== signature ||
    blockTime * 1000 < order.created_at.valueOf() - 60_000 ||
    blockTime * 1000 > order.expires_at.valueOf()
  )
    return false;
  const last = transaction.message.instructions.at(-1);
  if (!last) return false;
  const keys = [
    ...transaction.message.accountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const accounts = last.accounts.map((index) => keys[index]);
  if (accounts.some((key) => !key) || accounts.at(-1) !== order.reference)
    return false;
  const bytes = bs58.decodeUnsafe(last.data);
  if (!bytes) return false;
  const data = Buffer.from(bytes);
  const program = keys[last.programIdIndex];
  const expected = BigInt(order.amount_units);
  if (order.method === "sol") {
    const destination = last.accounts[1]!;
    const pre = meta.preBalances[destination];
    const post = meta.postBalances[destination];
    return (
      program === systemProgram &&
      accounts.length === 3 &&
      accounts[0] !== accounts[1] &&
      accounts[1] === order.recipient &&
      data.length === 12 &&
      data.readUInt32LE(0) === 2 &&
      data.readBigUInt64LE(4) === expected &&
      pre !== undefined &&
      post !== undefined &&
      BigInt(post) - BigInt(pre) === expected
    );
  }
  if (order.method !== "usdc" || program !== tokenProgram) return false;
  const mint = address(cluster[network(order)].mint);
  const [recipientAta] = await getProgramDerivedAddress({
    programAddress: associatedTokenProgram,
    seeds: [
      encodeAddress.encode(address(order.recipient)),
      encodeAddress.encode(tokenProgram),
      encodeAddress.encode(mint),
    ],
  });
  const checked =
    data.length === 10 &&
    data[0] === 12 &&
    data[9] === 6 &&
    accounts.length === 5 &&
    accounts[1] === mint;
  const unchecked = data.length === 9 && data[0] === 3 && accounts.length === 4;
  const destination = last.accounts[checked ? 2 : 1];
  if (
    (!checked && !unchecked) ||
    data.readBigUInt64LE(1) !== expected ||
    destination === undefined ||
    keys[destination] !== recipientAta ||
    accounts[0] === recipientAta
  )
    return false;
  const pre = findTokenBalance(meta.preTokenBalances, destination);
  const post = findTokenBalance(meta.postTokenBalances, destination);
  if (
    !post ||
    post.owner !== order.recipient ||
    post.mint !== mint ||
    post.programId !== tokenProgram ||
    (pre &&
      (pre.owner !== post.owner ||
        pre.mint !== post.mint ||
        pre.programId !== post.programId))
  )
    return false;
  return (
    BigInt(post.uiTokenAmount.amount) -
      BigInt(pre?.uiTokenAmount.amount ?? "0") ===
    expected
  );
}

function findTokenBalance(balances: unknown[] | undefined, index: number) {
  for (const balance of balances ?? []) {
    const parsed = tokenBalance.safeParse(balance);
    if (parsed.success && parsed.data.accountIndex === index)
      return parsed.data;
  }
}

export class SolanaPayments {
  private verified: Promise<void> | undefined;

  constructor(
    readonly url: string,
    readonly test: boolean,
    readonly recipient: string,
  ) {}

  private async rpc(method: string, params: unknown[]) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(3500),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Solana RPC unavailable");
    }
    const data = z
      .object({ result: z.unknown() })
      .parse(await boundedJson(response));
    if (data.result === undefined) throw new Error("Solana RPC request failed");
    return data.result;
  }

  verifyNetwork() {
    this.verified ??= this.rpc("getGenesisHash", [])
      .then((genesis) => {
        if (genesis !== cluster[this.test ? "devnet" : "mainnet-beta"].genesis)
          throw new Error("Solana network mismatch");
      })
      .catch((error: unknown) => {
        this.verified = undefined;
        throw error;
      });
    return this.verified;
  }

  async findPayment(order: Order, signature?: string) {
    if (order.test !== this.test || !order.reference) return;
    await this.verifyNetwork();
    const candidates = signature
      ? [signature]
      : z
          .array(
            z.object({
              signature: signatureSchema,
              err: z.unknown(),
              confirmationStatus: z.string().nullable(),
            }),
          )
          .max(12)
          .parse(
            await this.rpc("getSignaturesForAddress", [
              order.reference,
              { commitment: "finalized", limit: 12 },
            ]),
          )
          .filter(
            (entry) =>
              entry.err === null && entry.confirmationStatus === "finalized",
          )
          .map((entry) => entry.signature);
    // Ignore transactions that merely mention the order's reference.
    const results = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const result = await this.rpc("getTransaction", [
          candidate,
          {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          },
        ]);
        return (await matchesTransfer(order, candidate, result))
          ? candidate
          : undefined;
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) return result.value;
    }
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Solana transfer lookup failed");
  }
}
