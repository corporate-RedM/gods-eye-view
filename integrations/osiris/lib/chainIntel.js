// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { matchExact } from './sanctions.js';
const CHAIN_META = {
    bitcoin: { label: 'Bitcoin', symbol: 'BTC', decimals: 8, coingecko: 'bitcoin' },
    ethereum: { label: 'Ethereum', symbol: 'ETH', decimals: 18, coingecko: 'ethereum' },
    solana: { label: 'Solana', symbol: 'SOL', decimals: 9, coingecko: 'solana' },
};
const RE_ETH = /^0x[a-fA-F0-9]{40}$/;
const RE_BTC_BECH32 = /^bc1[a-z0-9]{25,62}$/;
const RE_BTC_LEGACY = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const RE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * Format-based chain detection. Order matters: ETH and bech32 are
 * unambiguous, while a 32–34 char base58 string beginning 1/3 is valid for
 * both BTC legacy and Solana — those resolve to BTC and set `ambiguous`,
 * which the caller can override with an explicit chain.
 */
export function detectChain(addressRaw) {
    const address = addressRaw.trim();
    if (RE_ETH.test(address))
        return { chain: 'ethereum', ambiguous: false };
    if (RE_BTC_BECH32.test(address))
        return { chain: 'bitcoin', ambiguous: false };
    if (RE_BTC_LEGACY.test(address)) {
        return { chain: 'bitcoin', ambiguous: RE_BASE58.test(address) };
    }
    if (RE_BASE58.test(address))
        return { chain: 'solana', ambiguous: false };
    return { chain: null, ambiguous: false };
}
/* ── fetch helpers ───────────────────────────────────────────── */
async function getJson(url, timeoutMs = 15000, init) {
    const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(init?.headers || {}) },
    });
    if (!res.ok)
        throw new Error(`${new URL(url).host} responded ${res.status}`);
    return res.json();
}
async function rpc(url, method, params, timeoutMs = 15000) {
    const body = await getJson(url, timeoutMs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (body.error)
        throw new Error(`${method}: ${body.error.message || 'RPC error'}`);
    return body.result;
}
/**
 * Spot USD price. CoinGecko's keyless tier rate-limits hard enough that a
 * per-lookup call starts returning nothing after a handful of scans, so
 * prices are cached process-wide and all three chains are fetched at once.
 * A stale price beats no price; failure is non-fatal either way.
 */
const PRICE_TTL = 120_000;
let priceCache = null;
async function fetchPrice(chain) {
    if (priceCache && Date.now() - priceCache.at < PRICE_TTL) {
        return priceCache.usd[chain] ?? null;
    }
    try {
        const ids = Object.keys(CHAIN_META).map(c => CHAIN_META[c].coingecko).join(',');
        const d = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, 10000);
        const usd = {};
        for (const c of Object.keys(CHAIN_META)) {
            const v = d?.[CHAIN_META[c].coingecko]?.usd;
            if (typeof v === 'number')
                usd[c] = v;
        }
        if (Object.keys(usd).length)
            priceCache = { at: Date.now(), usd };
        return usd[chain] ?? priceCache?.usd[chain] ?? null;
    }
    catch (e) {
        console.warn('[OSIRIS] price lookup failed:', e instanceof Error ? e.message : e);
        // Serve the last known price rather than blanking the USD column.
        return priceCache?.usd[chain] ?? null;
    }
}
/* ── per-chain collectors ────────────────────────────────────── */
const TX_PAGE = 50;
async function collectBitcoin(address) {
    const base = 'https://mempool.space/api';
    const info = await getJson(`${base}/address/${encodeURIComponent(address)}`);
    const cs = info.chain_stats || {};
    const sats = (n) => (Number(n) || 0) / 1e8;
    const totalIn = sats(cs.funded_txo_sum);
    const totalOut = sats(cs.spent_txo_sum);
    const partial = [];
    let transactions = [];
    try {
        const txs = await getJson(`${base}/address/${encodeURIComponent(address)}/txs`, 20000);
        transactions = (Array.isArray(txs) ? txs : []).map((t) => {
            // Sum this address's side of the ledger on both legs of the tx.
            const inFrom = (t.vin || []).reduce((s, v) => s + (v?.prevout?.scriptpubkey_address === address ? Number(v.prevout.value) || 0 : 0), 0);
            const outTo = (t.vout || []).reduce((s, v) => s + (v?.scriptpubkey_address === address ? Number(v.value) || 0 : 0), 0);
            const spent = sats(inFrom);
            const received = sats(outTo);
            const direction = spent > 0 && received > 0 ? 'self' : spent > 0 ? 'out' : received > 0 ? 'in' : 'unknown';
            // Counterparty = the largest party on the opposite leg.
            const pool = direction === 'out'
                ? (t.vout || []).filter((v) => v?.scriptpubkey_address && v.scriptpubkey_address !== address)
                : (t.vin || [])
                    .map((v) => v?.prevout)
                    .filter((p) => p?.scriptpubkey_address && p.scriptpubkey_address !== address);
            const top = pool.sort((a, b) => (Number(b?.value) || 0) - (Number(a?.value) || 0))[0];
            return {
                hash: t.txid,
                time: t.status?.block_time ? new Date(t.status.block_time * 1000).toISOString() : null,
                direction,
                value: direction === 'out' ? spent - received : received,
                counterparty: top?.scriptpubkey_address || null,
                fee: sats(t.fee),
            };
        });
    }
    catch (e) {
        partial.push(`transaction history unavailable (${e instanceof Error ? e.message : 'error'})`);
    }
    // mempool.space reports a true lifetime tx_count, so completeness is exact.
    const txCount = Number(cs.tx_count) || 0;
    return {
        balance: totalIn - totalOut,
        tx_count: txCount,
        history_complete: transactions.length >= txCount,
        flow: { total_in: totalIn, total_out: totalOut, net: totalIn - totalOut },
        transactions,
        labels: [],
        tokens: [],
        sources: ['mempool.space'],
        partial,
    };
}
async function collectEthereum(address) {
    const base = 'https://eth.blockscout.com/api/v2';
    const info = await getJson(`${base}/addresses/${encodeURIComponent(address)}`);
    const balance = Number(info.coin_balance || 0) / 1e18;
    const labels = [];
    if (info.ens_domain_name)
        labels.push(`ENS: ${info.ens_domain_name}`);
    // Blockscout sets is_contract for any address holding code, including EOAs
    // carrying an EIP-7702 delegation — those have no deployment transaction.
    // Calling those "smart contract" is wrong, so distinguish on the creation tx.
    if (info.is_contract) {
        if (info.creation_transaction_hash) {
            labels.push(info.is_verified ? 'Smart contract (verified source)' : 'Smart contract');
        }
        else {
            labels.push('Code at address, no deployment tx (EIP-7702 delegation)');
        }
    }
    if (info.has_beacon_chain_withdrawals)
        labels.push('Beacon chain withdrawals');
    const partial = [];
    let transactions = [];
    let txCount = 0;
    try {
        const txs = await getJson(`${base}/addresses/${encodeURIComponent(address)}/transactions`, 25000);
        const items = Array.isArray(txs.items) ? txs.items : [];
        txCount = items.length;
        const lower = address.toLowerCase();
        transactions = items.map((t) => {
            const from = (t.from?.hash || '').toLowerCase();
            const to = (t.to?.hash || '').toLowerCase();
            const direction = from === lower && to === lower ? 'self' : from === lower ? 'out' : to === lower ? 'in' : 'unknown';
            return {
                hash: t.hash,
                time: t.timestamp || null,
                direction,
                value: Number(t.value || 0) / 1e18,
                counterparty: direction === 'out' ? t.to?.hash || null : t.from?.hash || null,
                fee: t.fee?.value ? Number(t.fee.value) / 1e18 : undefined,
                failed: t.status === 'error' || t.result === 'error',
            };
        });
    }
    catch (e) {
        partial.push(`transaction history unavailable (${e instanceof Error ? e.message : 'error'})`);
    }
    let tokens = [];
    try {
        const tb = await getJson(`${base}/addresses/${encodeURIComponent(address)}/token-balances`, 15000);
        tokens = (Array.isArray(tb) ? tb : [])
            .slice(0, 25)
            .map((t) => {
            const dec = Number(t.token?.decimals);
            const raw = Number(t.value);
            return {
                symbol: t.token?.symbol || '???',
                name: t.token?.name || 'Unknown token',
                amount: Number.isFinite(raw) && Number.isFinite(dec) ? raw / 10 ** dec : null,
            };
        });
    }
    catch {
        partial.push('token balances unavailable');
    }
    // Blockscout reports totals only across the paged window, so derive flow
    // from the transactions actually seen rather than implying a full history.
    const flow = transactions.length
        ? {
            total_in: transactions.filter(t => t.direction === 'in').reduce((s, t) => s + t.value, 0),
            total_out: transactions.filter(t => t.direction === 'out').reduce((s, t) => s + t.value, 0),
            net: 0,
        }
        : null;
    if (flow)
        flow.net = flow.total_in - flow.total_out;
    return {
        balance,
        tx_count: txCount,
        // Blockscout pages newest-first and exposes no lifetime total; a page that
        // came back short is the only proof we reached the beginning.
        history_complete: transactions.length > 0 && transactions.length < TX_PAGE,
        flow,
        transactions,
        labels,
        tokens,
        sources: ['Blockscout'],
        partial,
    };
}
async function collectSolana(address) {
    const url = 'https://api.mainnet-beta.solana.com';
    const lamports = await rpc(url, 'getBalance', [address]);
    const balance = (Number(lamports?.value) || 0) / 1e9;
    const partial = [];
    let transactions = [];
    try {
        const sigs = await rpc(url, 'getSignaturesForAddress', [address, { limit: 50 }], 20000);
        transactions = (Array.isArray(sigs) ? sigs : []).map((s) => ({
            hash: s.signature,
            time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
            // Signature listings carry no transfer legs; resolving direction and
            // amounts needs a per-tx fetch, which the public RPC rate-limits hard.
            direction: 'unknown',
            value: 0,
            counterparty: null,
            failed: !!s.err,
        }));
    }
    catch (e) {
        partial.push(`signature history unavailable (${e instanceof Error ? e.message : 'error'})`);
    }
    partial.push('Solana transfer amounts and counterparties require a keyed RPC provider (HELIUS_API_KEY)');
    let tokens = [];
    try {
        const accs = await rpc(url, 'getTokenAccountsByOwner', [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }], 20000);
        tokens = (accs?.value || [])
            .slice(0, 25)
            .map((a) => {
            const info = a?.account?.data?.parsed?.info;
            return {
                symbol: (info?.mint || '').slice(0, 6) || '???',
                name: `SPL mint ${info?.mint || 'unknown'}`,
                amount: info?.tokenAmount?.uiAmount ?? null,
            };
        })
            .filter((t) => t.amount === null || t.amount > 0);
    }
    catch {
        partial.push('token accounts unavailable');
    }
    return {
        balance,
        tx_count: transactions.length,
        // Same reasoning as Ethereum: a full page means more signatures remain.
        history_complete: transactions.length > 0 && transactions.length < TX_PAGE,
        flow: null,
        transactions,
        labels: [],
        tokens,
        sources: ['Solana JSON-RPC'],
        partial,
    };
}
/* ── analysis ────────────────────────────────────────────────── */
function aggregateCounterparties(txs) {
    const map = new Map();
    for (const t of txs) {
        if (!t.counterparty)
            continue;
        const existing = map.get(t.counterparty);
        const dir = t.direction === 'in' || t.direction === 'out' ? t.direction : null;
        if (existing) {
            existing.txs += 1;
            existing.value += t.value;
            if (dir && existing.direction !== dir && existing.direction !== 'both')
                existing.direction = 'both';
        }
        else {
            map.set(t.counterparty, {
                address: t.counterparty,
                direction: dir ?? 'both',
                txs: 1,
                value: t.value,
            });
        }
    }
    return [...map.values()].sort((a, b) => b.txs - a.txs || b.value - a.value).slice(0, 15);
}
const LEVEL_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
function scoreRisk(factors) {
    const score = Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.weight, 0)));
    const highest = factors.reduce((acc, f) => (LEVEL_ORDER.indexOf(f.severity) > LEVEL_ORDER.indexOf(acc) ? f.severity : acc), 'info');
    // A sanctions hit must never be diluted by an otherwise-quiet wallet.
    if (highest === 'critical')
        return { score: Math.max(score, 95), level: 'critical' };
    const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : score >= 15 ? 'low' : 'info';
    return { score, level };
}
function buildFactors(raw, meta, activity, counterparties, sanctionHits) {
    const f = [];
    if (sanctionHits.length) {
        f.push({
            code: 'OFAC_SDN',
            label: 'OFAC-sanctioned address',
            severity: 'critical',
            weight: 100,
            detail: `Listed on the US OFAC SDN list as: ${sanctionHits.slice(0, 3).map(e => e.name).join('; ')}`,
        });
    }
    if (activity.age_days !== null && activity.age_days < 7) {
        f.push({
            code: 'NEW_ADDRESS',
            label: 'Recently created',
            severity: 'low',
            weight: 10,
            detail: `First activity ${activity.age_days} day(s) ago.`,
        });
    }
    if (activity.dormant_days !== null && activity.age_days !== null && activity.dormant_days > 365 && activity.age_days > 400) {
        f.push({
            code: 'DORMANT',
            label: 'Long dormant',
            severity: 'info',
            weight: 5,
            detail: `No activity for ${activity.dormant_days} days.`,
        });
    }
    if (raw.tx_count > 10000) {
        f.push({
            code: 'HIGH_VOLUME',
            label: 'Exchange-scale activity',
            severity: 'info',
            weight: 5,
            detail: `${raw.tx_count.toLocaleString()} transactions — consistent with an exchange, service or pooled wallet rather than a personal one.`,
        });
    }
    // Fan-out is only informative for wallets that aren't obviously services —
    // an exchange spreading across many counterparties is its normal operation.
    if (counterparties.length >= 12 && raw.tx_count <= 10000) {
        f.push({
            code: 'FAN_PATTERN',
            label: 'High counterparty fan-out',
            severity: 'medium',
            weight: 20,
            detail: `${counterparties.length} distinct counterparties across ${raw.transactions.length} sampled transactions — a distribution pattern also seen in mixing and payout scripts.`,
        });
    }
    const failed = raw.transactions.filter(t => t.failed).length;
    if (failed >= 5) {
        f.push({
            code: 'FAILED_TXS',
            label: 'Repeated failed transactions',
            severity: 'low',
            weight: 8,
            detail: `${failed} of ${raw.transactions.length} sampled transactions failed.`,
        });
    }
    if (raw.flow && raw.flow.total_in > 0 && raw.balance / raw.flow.total_in < 0.01 && raw.tx_count > 5) {
        f.push({
            code: 'DRAINED',
            label: 'Swept balance',
            severity: 'medium',
            weight: 15,
            detail: `Received ${raw.flow.total_in.toFixed(4)} ${meta.symbol} but retains ${raw.balance.toFixed(4)} — funds were forwarded on rather than held.`,
        });
    }
    if (!f.length) {
        f.push({
            code: 'NOMINAL',
            label: 'No risk indicators',
            severity: 'info',
            weight: 0,
            detail: 'Nothing in the sampled data matched a risk heuristic.',
        });
    }
    return f;
}
/* ── capabilities ────────────────────────────────────────────── */
export function capabilities() {
    return {
        etherscan: !!process.env.ETHERSCAN_API_KEY,
        helius: !!process.env.HELIUS_API_KEY,
    };
}
/* ── entry point ─────────────────────────────────────────────── */
export async function analyseAddress(addressRaw, chainOverride) {
    const address = addressRaw.trim();
    const detection = detectChain(address);
    const chain = chainOverride ?? detection.chain;
    if (!chain)
        throw new Error('Unrecognised address format for BTC, ETH or SOL');
    const meta = CHAIN_META[chain];
    const [raw, price, sanctionHits] = await Promise.all([
        chain === 'bitcoin'
            ? collectBitcoin(address)
            : chain === 'ethereum'
                ? collectEthereum(address)
                : collectSolana(address),
        fetchPrice(chain),
        // OFAC lists sanctioned wallets as entity names, so an exact-name lookup
        // is the correct screen; normalisation lower-cases both sides.
        matchExact(address).catch(() => []),
    ]);
    const times = raw.transactions.map(t => t.time).filter((t) => !!t).sort();
    const firstSeen = times[0] ?? null;
    const lastSeen = times[times.length - 1] ?? null;
    const day = 86_400_000;
    // Chain APIs page newest-first, so the sample only reaches the true first
    // transaction when it covers the whole history. Deriving an age from a
    // partial sample would report a 2009 address as days old.
    const historyComplete = raw.history_complete;
    const activity = {
        tx_count: raw.tx_count,
        first_seen: firstSeen,
        last_seen: lastSeen,
        age_days: historyComplete && firstSeen ? Math.floor((Date.now() - Date.parse(firstSeen)) / day) : null,
        dormant_days: lastSeen ? Math.floor((Date.now() - Date.parse(lastSeen)) / day) : null,
        sample_size: raw.transactions.length,
        history_complete: historyComplete,
    };
    const counterparties = aggregateCounterparties(raw.transactions);
    const factors = buildFactors(raw, meta, activity, counterparties, sanctionHits);
    const risk = scoreRisk(factors);
    return {
        address,
        chain,
        chain_label: meta.label,
        symbol: meta.symbol,
        ambiguous_chain: detection.ambiguous && !chainOverride,
        balance: {
            native: raw.balance,
            usd: price !== null ? raw.balance * price : null,
            price_usd: price,
        },
        activity,
        flow: raw.flow,
        counterparties,
        transactions: raw.transactions.slice(0, 25),
        sanctions: { screened: true, hit: sanctionHits.length > 0, entries: sanctionHits.slice(0, 5) },
        risk: { ...risk, factors },
        labels: raw.labels,
        tokens: raw.tokens,
        sources: [...raw.sources, 'CoinGecko', 'OpenSanctions / US OFAC SDN'],
        partial: raw.partial,
    };
}
