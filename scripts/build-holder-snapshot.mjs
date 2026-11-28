import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const chainId = 4663;
const holderLimit = 50;
const burnAddress = "0x000000000000000000000000000000000000dead";
const contract = "0x11B70d0243baf75E85CE03201A92b5B7C33BEB59";
const explorer = "https://robinhoodchain.blockscout.com";
const holdersPage = `${explorer}/token/${contract}?tab=holders`;
const tokenPath = `/api/v2/tokens/${contract}`;
const supplySource = `${explorer}${tokenPath}`;
const walletLabels = {
  [burnAddress]: {
    name: "Burn wallet",
    source: "https://verify-robin-pond.smilingbeaver2.chatgpt.site/#supply",
  },
  "0x2dbaf98620ac5bbe3441f756feff82702d095b1a": {
    name: "MEXC hot wallet",
    source: "https://ribbitpaper.com/reference#mexc",
  },
  "0x267444d099b10fb5ed7c3cc7b7c767adca574952": {
    name: "Pons V2 locker",
    source: "https://ribbitpaper.com/reference#liquidity",
  },
  "0x8366a39cc670b4001a1121b8f6a443a643e40951": {
    name: "Uniswap v4 Pool Manager",
    source: "https://github.com/Uniswap/UniswapX/blob/main/playbook/chains/robinhood.md",
  },
};
const usdGPairId = "0x5eac4195930d5ff8b7a34a347f2bde951c42eb730d6e26075bea3dd7c66feb40";
const usdGToken = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const priceSource = `https://dexscreener.com/robinhood/${usdGPairId}`;

function formatBalance(value) {
  const padded = value.padStart(19, "0");
  const whole = padded.slice(0, -18);
  const fraction = padded.slice(-18).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function formatSupplyShare(balance, supply) {
  if (!supply || balance > supply) return null;
  const scale = 10_000n;
  const rounded = (balance * 100n * scale + supply / 2n) / supply;
  return `${rounded / scale}.${(rounded % scale).toString().padStart(4, "0")}`;
}

function blockscoutSources(path, apiKey) {
  const publicSource = new URL(path, explorer);
  if (!apiKey) return [publicSource];
  const proSource = new URL(`https://api.blockscout.com/${chainId}${path}`);
  proSource.searchParams.set("apikey", apiKey);
  return [proSource, publicSource];
}

// Limit all history requests to fewer than five requests per second.
let historyQueue = Promise.resolve();
async function historyJson(path, apiKey) {
  for (const url of blockscoutSources(path, apiKey)) {
    const slot = historyQueue;
    historyQueue = slot.then(() => new Promise(resolve => setTimeout(resolve, 300)));
    await slot;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" },
        redirect: "manual", signal: AbortSignal.timeout(4500) });
      if (response.ok) return await response.json();
    } catch { /* Never log URLs containing API credentials. */ }
  }
  throw new Error("History unavailable");
}

function transferRows(payload, address, endBlock, sort) {
  if (!Array.isArray(payload?.result) || !["0", "1"].includes(payload.status)
    || (payload.status === "0" && (payload.result.length || !/no (transactions|token transfers|records) found/i.test(payload.message)))) {
    throw new Error("Incomplete transfer history");
  }
  let previous = sort === "asc" ? 0 : Number.MAX_SAFE_INTEGER;
  return payload.result.map(row => {
    const timestamp = Number(row.timeStamp), block = Number(row.blockNumber);
    if (row.contractAddress?.toLowerCase() !== contract.toLowerCase()
      || !/^0x[0-9a-f]{40}$/i.test(row.from ?? "") || !/^0x[0-9a-f]{40}$/i.test(row.to ?? "")
      || ![row.from.toLowerCase(), row.to.toLowerCase()].includes(address.toLowerCase())
      || String(row.tokenDecimal) !== "18" || !/^\d{1,78}$/.test(row.value ?? "")
      || !/^0x[0-9a-f]{64}$/i.test(row.hash ?? "")
      || !Number.isSafeInteger(timestamp) || timestamp <= 0
      || !Number.isSafeInteger(block) || block < 0 || block > endBlock
      || (sort === "asc" ? timestamp < previous : timestamp > previous)) throw new Error("Invalid transfer history");
    previous = timestamp;
    return { ...row, timestamp, units: BigInt(row.value) };
  });
}

async function walletHistory(address, endBlock, endTime, apiKey) {
  const base = { module: "account", action: "tokentx", address,
    contractaddress: contract, startblock: "0", endblock: String(endBlock) };
  const request = async (sort, page, offset) => transferRows(await historyJson(
    `/api?${new URLSearchParams({ ...base, sort, page: String(page), offset: String(offset) })}`,
    apiKey), address, endBlock, sort);
  const result = { firstHeldAt: null, firstHeldTransaction: null, change24h: null };
  // Ascending history establishes the first receipt, including zero-value spam safely.
  try {
    for (let page = 1; page <= 10; page++) {
      const rows = await request("asc", page, 100);
      const first = rows.find(row => row.units > 0n && row.to.toLowerCase() === address.toLowerCase());
      if (first) {
        result.firstHeldAt = new Date(first.timestamp * 1000).toISOString();
        result.firstHeldTransaction = `${explorer}/tx/${first.hash}`;
        break;
      }
      if (rows.length < 100) break;
    }
  } catch { /* Missing dates stay unavailable. */ }
  try {
    let change = 0n, previousTime = Infinity;
    const cutoff = endTime - 86400;
    for (let page = 1; page <= 10; page++) {
      const rows = await request("desc", page, 1000);
      if (rows.length && rows[0].timestamp > previousTime) throw new Error("Unstable pagination");
      for (const row of rows) {
        if (row.timestamp > endTime) throw new Error("Unstable window");
        if (row.timestamp > cutoff) {
          if (row.to.toLowerCase() === address.toLowerCase()) change += row.units;
          if (row.from.toLowerCase() === address.toLowerCase()) change -= row.units;
        }
      }
      if (rows.length < 1000 || rows.at(-1).timestamp <= cutoff) {
        result.change24h = (change < 0n ? "-" : "") + formatBalance((change < 0n ? -change : change).toString());
        break;
      }
      previousTime = rows.at(-1).timestamp;
    }
  } catch { /* Do not present a partial sum as a complete 24-hour change. */ }
  return result;
}

async function addHolderHistory(data, apiKey) {
  for (const holder of data.holders) Object.assign(holder,
    { firstHeldAt: null, firstHeldTransaction: null, change24h: null });
  data.changeWindow = null;
  try {
    const blocks = await historyJson("/api/v2/blocks?type=block", apiKey);
    const block = blocks?.items?.[0];
    const height = Number(block?.height), endTime = Date.parse(block?.timestamp) / 1000;
    if (!Number.isSafeInteger(height) || height < 0 || !Number.isSafeInteger(endTime)
      || Math.abs(Date.parse(data.fetchedAt) / 1000 - endTime) > 3600) return;
    data.changeWindow = { start: new Date((endTime - 86400) * 1000).toISOString(),
      end: new Date(endTime * 1000).toISOString(), endBlock: height,
      definition: "Net indexed ROBIN transfers in (start, end]; not trading profit or loss." };
    let index = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (index < data.holders.length) {
        const holder = data.holders[index++];
        Object.assign(holder, await walletHistory(holder.address, height, endTime, apiKey));
      }
    }));
  } catch { /* The balance snapshot remains available if history is unavailable. */ }
}

function signedChange(decimal) {
  if (decimal === null || decimal === undefined) return "Unavailable";
  const negative = decimal.startsWith("-");
  const units = toTokenUnits(negative ? decimal.slice(1) : decimal);
  if (units === 0n) return "0.00";
  return `${negative ? "−" : "+"}${units < 5_000_000_000_000_000n ? "&lt;0.01" : formatRoundedUnits(units, 18, 2)}`;
}

function blockscoutSourceName(url) {
  return url.hostname === "api.blockscout.com" ? "keyed API" : "public explorer";
}

async function fetchIndexedSupply(apiKey) {
  for (const url of blockscoutSources(tokenPath, apiKey)) {
    const source = blockscoutSourceName(url);
    try {
      const upstream = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(3500),
      });
      if (!upstream.ok) {
        console.warn(`Blockscout token supply: ${source} returned HTTP ${upstream.status}.`);
        continue;
      }
      const token = await upstream.json();
      const supply = token?.total_supply;
      if (token?.address_hash?.toLowerCase() === contract.toLowerCase()
        && String(token.decimals) === "18"
        && typeof supply === "string" && /^\d{1,78}$/.test(supply) && BigInt(supply) > 0n) {
        console.log(`Blockscout token supply: using ${source}.`);
        return supply;
      }
      console.warn(`Blockscout token supply: ${source} returned invalid supply data.`);
    } catch {
      console.warn(`Blockscout token supply: ${source} request or response parsing failed.`);
    }
  }
  return null;
}

function toTokenUnits(decimal) {
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt(whole + fraction.padEnd(18, "0"));
}

function formatRoundedUnits(units, sourceDecimals, displayDecimals) {
  const divisor = 10n ** BigInt(sourceDecimals - displayDecimals);
  const rounded = (units + divisor / 2n) / divisor;
  const scale = 10n ** BigInt(displayDecimals);
  const whole = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (rounded % scale).toString().padStart(displayDecimals, "0");
  return `${whole}.${fraction}`;
}

async function fetchUsdGQuote() {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${usdGPairId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) return null;
    const { pairs } = await response.json();
    const pair = pairs?.find((item) =>
      item.chainId === "robinhood" && item.dexId === "uniswap"
      && item.pairAddress?.toLowerCase() === usdGPairId
      && item.baseToken?.address?.toLowerCase() === contract.toLowerCase()
      && item.quoteToken?.address?.toLowerCase() === usdGToken
    );
    const price = pair?.priceNative;
    return normalizeQuote(price, "DEX Screener", priceSource);
  } catch {
    return null;
  }
}

function normalizeQuote(price, name, url) {
  if (typeof price !== "string" || !/^\d{1,18}(?:\.\d{1,18})?$/.test(price)) return null;
  const units = toTokenUnits(price);
  return units > 0n ? { price, units, name, url } : null;
}

async function fetchGeckoQuote() {
  const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${usdGPairId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) return null;
  const { data } = await response.json();
  if (data?.id !== `robinhood_${usdGPairId}`
    || data.relationships?.base_token?.data?.id !== `robinhood_${contract.toLowerCase()}`
    || data.relationships?.quote_token?.data?.id !== `robinhood_${usdGToken}`) return null;
  return normalizeQuote(data.attributes?.base_token_price_quote_token, "GeckoTerminal", `https://www.geckoterminal.com/robinhood/pools/${usdGPairId}`);
}

async function fetchAvailableQuote() {
  const sources = [fetchUsdGQuote, fetchGeckoQuote];
  try {
    return await Promise.any(sources.map(async (source) => {
      const quote = await source();
      if (!quote) throw new Error("Quote unavailable");
      return quote;
    }));
  } catch {
    return null;
  }
}

function quoteFallbackScript() {
  const config = { contract, usdGPairId, usdGToken, priceSource };
  const helpers = [toTokenUnits, formatRoundedUnits, normalizeQuote, fetchUsdGQuote, fetchGeckoQuote, fetchAvailableQuote];
  return `<script>
const { contract, usdGPairId, usdGToken, priceSource } = ${JSON.stringify(config)};
${helpers.map((helper) => helper.toString()).join("\n")}
(async () => {
  const quote = await fetchAvailableQuote();
  if (!quote) return;
  for (const cell of document.querySelectorAll("[data-robin-units]")) {
    cell.querySelector(".value-amount").textContent =
      formatRoundedUnits(BigInt(cell.dataset.robinUnits) * quote.units, 36, 2);
  }
  const status = document.querySelector(".quote");
  const link = document.createElement("a");
  link.href = quote.url;
  link.textContent = quote.name;
  status.replaceChildren("1 ROBIN = " + quote.price + " USDG via ", link, ". Values are spot estimates before fees and slippage.");
})();
</script>`;
}

function renderHolderPage(data, quote = null) {
  const rows = data?.holders.map(({ rank, address, balance, explorer, label, supplySharePercent, firstHeldAt, firstHeldTransaction, change24h }) => {
    const isBurn = address.toLowerCase() === burnAddress;
    const units = toTokenUnits(balance);
    const usdGValue = isBurn ? "0.00" : quote ? formatRoundedUnits(units * quote.units, 36, 2) : "—";
    const share = supplySharePercent === null ? "—"
      : Number(supplySharePercent) < 0.005 ? "&lt;0.01%" : `${Number(supplySharePercent).toFixed(2)}%`;
    return `<tr role="row" data-rank="${rank}" data-balance="${units}" data-change="${change24h ?? ""}" data-first="${firstHeldAt ?? ""}">
      <td class="rank" role="cell"><span class="mobile-label" aria-hidden="true">Rank</span>${rank}</td>
      <th class="holder-address" scope="row" role="rowheader"><a class="wallet" href="${explorer}">${address}</a><button class="copy-address" type="button" aria-label="Copy address for rank ${rank}" hidden>Copy address</button><button class="row-details" type="button" aria-expanded="false" aria-label="Details for rank ${rank}" hidden>More details</button></th>
      <td class="wallet-label" role="cell"><span class="mobile-label" aria-hidden="true">Wallet label</span>${label ? `<a href="${label.source}">${label.name}</a>` : "—"}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">Balance (ROBIN)</span>${formatRoundedUnits(units, 18, 2)}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">% of total supply</span>${share}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">First held (UTC)</span>${firstHeldAt ? `<a href="${firstHeldTransaction}" title="First recorded positive ROBIN receipt">${firstHeldAt.slice(0, 10)}</a>` : "Unavailable"}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">24h change (ROBIN)</span>${signedChange(change24h)}</td>
      <td class="balance value" role="cell"${!quote && !isBurn ? ` data-robin-units="${units}"` : ""}><span class="mobile-label" aria-hidden="true">Est. value (USDG)</span><span class="value-amount">${usdGValue}</span></td>
    </tr>`;
  }).join("");
  const content = `
    <form class="holder-search" role="search" aria-label="Search the Top 50 snapshot" hidden>
      <label for="holder-query">Search the Top 50</label>
      <div class="holder-search-controls">
        <input id="holder-query" type="search" placeholder="Wallet address or label" aria-describedby="holder-search-help" autocomplete="off" autocapitalize="none" spellcheck="false">
        <button type="button" hidden>Clear</button>
      </div>
      <p id="holder-search-help">Paste a full or partial wallet address, or search a published label.</p>
      <label for="holder-sort">Sort by</label>
      <select id="holder-sort">
        <option value="rank">Holder rank</option>
        <option value="balance-desc">Balance · highest first</option>
        <option value="balance-asc">Balance · lowest first</option>
        <option value="change-desc">24h change · highest first</option>
        <option value="change-asc">24h change · lowest first</option>
        <option value="first-asc">First held · earliest first</option>
        <option value="first-desc">First held · newest first</option>
      </select>
      <p class="holder-search-status" role="status"></p>
    </form>
    <section class="wallet-summary" aria-label="Matching wallet summary" hidden></section>
    <p class="lookup-wallet" hidden><a>View this address on Blockscout</a></p>
    <p class="copy-status" role="status"></p>
    <p class="status snapshot-age"><strong class="relative-age"></strong>Last updated <time datetime="${data.fetchedAt}">${data.fetchedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC")}</time></p>
    <p class="quote" aria-live="polite">${quote ? `1 ROBIN = ${quote.price} USDG via <a href="${quote.url}">${quote.name}</a>. Values are spot estimates before fees and slippage.` : `USDG estimates are temporarily unavailable. <a href="${priceSource}">View the ROBIN/USDG market</a>.`}</p>
    <p class="status">${data.totalSupply === null ? "Total supply is temporarily unavailable. Balances and wallet labels are shown below."
      : `Supply shares use <a href="${supplySource}">Blockscout’s indexed contract total supply</a>, including the balance at the burn address. Balances and supply may be indexed at different blocks.`}</p>
    <details class="status"><summary>About first-held dates and 24-hour changes</summary><p>First held is the earliest positive ROBIN receipt recorded by Blockscout, linked to its transaction. It does not mean the wallet held continuously. The 24-hour change is ROBIN received minus ROBIN sent, including transfers; it is not trading profit or loss. Unavailable means the history could not be verified completely.</p><p>${data.changeWindow ? `24-hour window (UTC): ${data.changeWindow.start} to ${data.changeWindow.end}, through block ${data.changeWindow.endBlock}.` : "The indexed 24-hour window is temporarily unavailable."} Balances may reflect a different indexing moment.</p></details>
    <div class="table-region">
      <table role="table" aria-label="Top 50 ROBIN holder addresses">
        <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Rank</th><th scope="col" role="columnheader">Holder address</th><th scope="col" role="columnheader">Wallet label</th><th scope="col" role="columnheader" class="balance">Balance (ROBIN)</th><th scope="col" role="columnheader" class="balance">% of total supply</th><th scope="col" role="columnheader" class="balance">First held (UTC)</th><th scope="col" role="columnheader" class="balance">24h change (ROBIN)</th><th scope="col" role="columnheader" class="balance value">Est. value (USDG)</th></tr></thead>
        <tbody role="rowgroup">${rows}</tbody>
      </table>
    </div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1c2d">
<meta name="description" content="Scheduled snapshot of balances for the top 50 ROBIN holder addresses on Robinhood Chain.">
<title>Top 50 ROBIN holders</title>
<style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1c2d;color:#fff7da}
  *{box-sizing:border-box}
  body{margin:0}
  main{max-width:92rem;margin:auto;padding:clamp(1rem,4vw,3rem)}
  header{background:#10283d;border:1px solid #476079;border-radius:1rem;padding:clamp(1.15rem,4vw,2.5rem)}
  .chain{margin:0;color:#d8af5c;font-size:.9rem}
  h1{margin:.35rem 0;font-size:clamp(1.9rem,6vw,3.45rem);line-height:1.05;letter-spacing:-.035em}
  p{line-height:1.5}
  .intro,.status{color:#c4ced5}
  nav{display:flex;flex-wrap:wrap;gap:.65rem 1.25rem;margin-top:1rem}
  a{color:#b5e65d;text-underline-offset:.22em}
  a:hover{color:#fff7da}
  :focus-visible{outline:2px solid #b5e65d;outline-offset:3px}
  .live-link{display:inline-block;padding:.55rem .9rem;border-radius:.5rem;background:#b5e65d;color:#0b1c2d;font-weight:700;text-decoration:none}
  .live-link:hover{background:#fff7da;color:#0b1c2d;text-decoration:underline}
  nav{align-items:center}
  .status{font-size:.875rem;margin:1.1rem 0 .65rem}
  .quote{color:#c4ced5;font-size:.875rem;margin:0 0 .75rem}
  .unavailable{padding:1rem;border:1px solid #476079;border-radius:.75rem}
  .holder-search{margin-block:1.25rem;padding:1rem;border:1px solid #476079;border-radius:.75rem;background:#10283d}
  .holder-search label{display:block;margin-bottom:.5rem;font-weight:700}
  .holder-search-controls{display:flex;flex-wrap:wrap;gap:.5rem}
  .holder-search :is(input,button){min-height:44px;padding:.5rem .75rem;border:1px solid #7e94a7;border-radius:.5rem;font:inherit}
  .holder-search input{flex:1 1 14rem;min-width:0;background:#0b1c2d;color:#fff7da}
  .holder-search input::placeholder{color:#c4ced5}
  .holder-search button{background:#b5e65d;color:#0b1c2d;font-weight:700;cursor:pointer}
  .holder-search p{margin:.5rem 0 0;color:#c4ced5;font-size:.875rem}
  .holder-search-status:empty{margin:0}
  .holder-search[hidden],.holder-search button[hidden],tbody tr[hidden]{display:none}
  .table-region{overflow-x:auto;border:1px solid #476079;border-radius:.75rem}
  table{width:100%;min-width:74rem;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}
  th,td{padding:.75rem 1rem;border-bottom:1px solid #476079;vertical-align:top}
  thead{background:#19364d}
  tbody tr:nth-child(even){background:#0d2134}
  tbody tr:last-child>*{border-bottom:0}
  tbody th{font-weight:400}
  td:first-child{width:4.5rem;color:#c4ced5}
  .wallet{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
  .balance{text-align:right;overflow-wrap:anywhere}
  .mobile-label{display:none}
  @media(max-width:76rem){
    .live-link{display:inline-flex;align-items:center;min-height:44px}
    .table-region{border:0;overflow:visible}
    table,tbody{display:block;min-width:0}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem 1rem;margin-bottom:.75rem;padding:1rem;border:1px solid #476079;border-radius:.75rem;background:#10283d}
    tbody :is(th,td){display:block;min-width:0;padding:0;border:0;text-align:left}
    tbody .rank{width:auto;font-weight:700}
    .holder-address,.wallet-label,.rank{grid-column:1/-1}
    .holder-address{overflow-wrap:anywhere}
    .mobile-label{display:block;margin-bottom:.2rem;color:#c4ced5;font-size:.875rem}
    .rank .mobile-label{display:inline;margin:0 .35rem 0 0}
  }

  [hidden]{display:none!important}
  button,select{font:inherit}
  .holder-search select{min-height:44px;max-width:100%;padding:.5rem .75rem;background:#0b1c2d;color:#fff7da;border:1px solid #7e94a7;border-radius:.5rem}
  .holder-search label[for="holder-sort"]{margin-top:.9rem}
  .copy-address,.row-details{min-height:44px;margin:.5rem .5rem 0 0;padding:.4rem .65rem;border:1px solid #7e94a7;border-radius:.5rem;background:#19364d;color:#fff7da;cursor:pointer}
  .wallet{display:block}
  .row-details{display:none}
  .relative-age{display:block;color:#fff7da;margin-bottom:.25rem}
  .snapshot-age.stale .relative-age{color:#f4cca0}
  .wallet-summary{margin:1rem 0;padding:1rem;background:#10283d;border:1px solid #7e94a7;border-radius:.75rem}
  .wallet-summary h2{margin:0 0 .75rem;font-size:1.15rem}
  .wallet-summary dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.8rem;margin:0}
  .wallet-summary dt{font-size:.875rem;color:#c4ced5}
  .wallet-summary dd{margin:.25rem 0 0;overflow-wrap:anywhere}
  .wallet-summary .mobile-label{display:none}
  .lookup-wallet a{display:inline-flex;align-items:center;min-height:44px}
  .copy-status:empty{display:none}
  @media(max-width:76rem){
    .row-details:not([hidden]){display:inline-block}
    .has-holder-tools tbody tr:not(.expanded)>td:not(.rank):not(:nth-child(4)){display:none}
    .has-holder-tools tbody tr>.wallet-label{display:none}
    .has-holder-tools tbody tr.expanded>.wallet-label{display:block}
    .has-holder-tools tbody tr>.holder-address{order:1}
    .has-holder-tools tbody tr>.rank{order:0}
    .has-holder-tools tbody tr>td:nth-child(4){order:2;grid-column:1/-1}
    .has-holder-tools tbody tr>td:not(.rank):not(:nth-child(4)){order:3}
  }

  @font-face{font-family:Nunito;src:url("https://ribbitpaper.com/trade/nunito-black-italic.woff2") format("woff2");font-weight:900;font-style:italic;font-display:swap}
  :root{font-family:Arial,sans-serif}
  body{background:radial-gradient(ellipse at 95% 0,#1c3d57 0,transparent 45%);line-height:1.65;min-height:100vh}
  header{background:linear-gradient(130deg,#142e44,#0d2134);border-top:2px solid #d8af5c}
  .paper-brand{display:inline-flex;align-items:center;min-height:44px;margin-bottom:.75rem;font:italic 900 1.35rem Nunito,ui-rounded,sans-serif;color:#fff7da;text-decoration:none}
  .chain{font-size:.76rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
  h1,.wallet-summary h2{font-family:Nunito,ui-rounded,sans-serif;font-style:italic;font-weight:900;line-height:1.15}
  h1 span{color:#b5e65d}
  nav a{display:inline-flex;align-items:center;min-height:44px}
  .live-link,.holder-search button{background:#d8af5c;border-color:#d8af5c;color:#0b1c2d}
  .live-link:hover,.holder-search button:hover{background:#fff7da;color:#0b1c2d}
  .holder-search,.wallet-summary{background:linear-gradient(130deg,#142e44,#0d2134);border-top:2px solid #d8af5c}
  .holder-search input,.holder-search select{border-color:#7e94a7}
  .wallet-summary h2{color:#fff7da}
  .row-details,.copy-address{border-color:#d8af5c}
  .row-details:hover,.copy-address:hover{background:#24465e}
  .rank{color:#d8af5c!important}
  .snapshot-age .relative-age{color:#b5e65d}
  .snapshot-age.stale .relative-age{color:#f4cca0}
  .status summary{color:#d8af5c}
  @media(max-width:76rem){.has-holder-tools tbody tr{border-top:2px solid #d8af5c}}
</style>
</head>
<body>
<main>
  <header>
    <a class="paper-brand" href="https://ribbitpaper.com/">The Ribbit Paper</a><p class="chain">Robinhood Chain · Holder snapshot</p>
    <h1>Top 50 <span>ROBIN</span> holders</h1>
    <p class="intro">Wallet and contract addresses ranked by token balance. This snapshot is scheduled to refresh hourly.</p>
    <nav aria-label="Data sources"><a class="live-link" href="${holdersPage}">View live on Blockscout</a><a href="https://ribbitpaper.com/rh-trends/">RH Trends</a><a href="./holders.json">Raw JSON</a></nav>
  </header>
  ${content}
</main>
<script>
(() => {
  const form = document.querySelector(".holder-search");
  const input = form.querySelector("input");
  const clear = form.querySelector("button");
  const sort = form.querySelector("select");
  const status = form.querySelector('[role="status"]');
  const summary = document.querySelector(".wallet-summary");
  const lookup = document.querySelector(".lookup-wallet");
  const tbody = document.querySelector("tbody");
  const holders = Array.from(tbody.rows, (row) => ({
    row,
    rank: Number(row.dataset.rank),
    address: row.querySelector(".wallet").textContent.toLowerCase(),
    label: row.querySelector(".wallet-label a")?.textContent.toLowerCase() ?? "",
  }));

  function sortValue(field, value) {
    if (field === "first") return value;
    if (field === "balance") return BigInt(value);
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    const units = BigInt(whole + fraction.padEnd(18, "0"));
    return negative ? -units : units;
  }

  function compare(left, right) {
    if (sort.value === "rank") return left.rank - right.rank;
    const [field, direction] = sort.value.split("-");
    const a = left.row.dataset[field];
    const b = right.row.dataset[field];
    if (!a || !b) return a ? -1 : b ? 1 : left.rank - right.rank;
    const av = sortValue(field, a);
    const bv = sortValue(field, b);
    const order = av < bv ? -1 : av > bv ? 1 : 0;
    return (direction === "asc" ? order : -order) || left.rank - right.rank;
  }

  function filterHolders() {
    const query = input.value.trim().toLowerCase();
    const matches = holders.filter(({ row, address, label }) => {
      row.hidden = !(address.includes(query) || label.includes(query));
      return !row.hidden;
    });
    for (const holder of [...holders].sort(compare)) tbody.append(holder.row);
    status.textContent = !query ? "" : matches.length
      ? matches.length + " of " + holders.length + " holders match."
      : "No matches in this Top 50 snapshot.";
    clear.hidden = !input.value;
    lookup.hidden = matches.length > 0 || !/^0x[a-f0-9]{40}$/.test(query);
    lookup.querySelector("a").href = "https://robinhoodchain.blockscout.com/address/" + query;
    summary.replaceChildren();
    summary.hidden = true;
    const exact = matches.find(holder => holder.address === query);
    if (exact) {
      const heading = document.createElement("h2");
      heading.textContent = "Wallet summary · rank " + exact.rank;
      const metrics = document.createElement("dl");
      for (const [label, index] of [["Balance (ROBIN)", 3], ["% of total supply", 4], ["24h change (ROBIN)", 6]]) {
        const group = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = label;
        const value = document.createElement("dd");
        const cell = exact.row.cells[index].cloneNode(true);
        cell.querySelector(".mobile-label")?.remove();
        value.textContent = cell.textContent.trim();
        group.append(term, value);
        metrics.append(group);
      }
      summary.append(heading, metrics);
      summary.hidden = false;
    }
  }

  for (const { row, rank } of holders) {
    const copy = row.querySelector(".copy-address");
    copy.hidden = false;
    copy.addEventListener("click", async () => {
      const message = document.querySelector(".copy-status");
      try {
        await navigator.clipboard.writeText(row.querySelector(".wallet").textContent);
        message.textContent = "Address copied for rank " + rank + ".";
      } catch {
        message.textContent = "Select the wallet address to copy it.";
      }
    });
    const details = row.querySelector(".row-details");
    details.hidden = false;
    details.addEventListener("click", () => {
      const open = row.classList.toggle("expanded");
      details.setAttribute("aria-expanded", String(open));
      details.textContent = open ? "Fewer details" : "More details";
    });
  }

  function updateAge() {
    const age = document.querySelector(".snapshot-age");
    const timestamp = Date.parse(age.querySelector("time").dateTime);
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    age.classList.toggle("stale", minutes >= 120);
    age.querySelector("strong").textContent = minutes < 0 ? "Snapshot time is ahead of this device"
      : minutes < 1 ? "Updated just now"
      : minutes < 60 ? "Updated " + minutes + " minutes ago"
      : "Updated " + Math.floor(minutes / 60) + " hours ago";
  }

  form.addEventListener("submit", event => event.preventDefault());
  input.addEventListener("input", filterHolders);
  sort.addEventListener("change", filterHolders);
  clear.addEventListener("click", () => {
    input.value = "";
    filterHolders();
    input.focus();
  });
  document.documentElement.classList.add("has-holder-tools");
  filterHolders();
  updateAge();
  setInterval(updateAge, 60000);
  form.hidden = false;
})();

</script>
${!quote ? quoteFallbackScript() : ""}
</body>
</html>`;
}

async function fetchHolderData(apiKey) {
  const supplyPromise = fetchIndexedSupply(apiKey);
  const sources = blockscoutSources(`${tokenPath}/holders`, apiKey);

  for (const url of sources) {
    const source = blockscoutSourceName(url);
    try {
      const upstream = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(7000),
      });
      if (!upstream.ok) {
        console.warn(`Blockscout Top 50 holders: ${source} returned HTTP ${upstream.status}.`);
        continue;
      }

      const payload = await upstream.json();
      const rows = payload.items?.slice(0, holderLimit);
      if (rows?.length !== holderLimit || rows.some(({ address, value }) =>
        !/^0x[a-f0-9]{40}$/i.test(address?.hash ?? "") ||
        typeof value !== "string" || !/^\d{1,78}$/.test(value) || BigInt(value) === 0n
      )) {
        console.warn(`Blockscout Top 50 holders: ${source} returned invalid holder data.`);
        continue;
      }

      const fetchedAt = new Date().toISOString();
      const supply = await supplyPromise;
      const supplyUnits = supply === null ? null : BigInt(supply);
      const data = {
        chain: "Robinhood Chain",
        chainId,
        token: "ROBIN",
        contract,
        fetchedAt,
        source: holdersPage,
        totalSupply: supply === null ? null : formatBalance(supply),
        supplySource,
        holders: rows.map(({ address, value }, index) => ({
          rank: index + 1,
          address: address.hash,
          balance: formatBalance(value),
          explorer: `${explorer}/address/${address.hash}`,
          label: walletLabels[address.hash.toLowerCase()] ?? null,
          supplySharePercent: formatSupplyShare(BigInt(value), supplyUnits),
        })),
      };
      console.log(`Blockscout Top 50 holders: using ${source}.`);
      return data;
    } catch {
      console.warn(`Blockscout Top 50 holders: ${source} request or response parsing failed.`);
    }
  }

  return null;
}

async function buildHolderSnapshot(apiKey) {
  const [data, quote] = await Promise.all([fetchHolderData(apiKey), fetchAvailableQuote()]);
  if (!data) throw new Error("Blockscout did not return a valid Top 50 snapshot.");

  await addHolderHistory(data, apiKey);
  return { html: renderHolderPage(data, quote), data };
}

export { transferRows, walletHistory, signedChange, renderHolderPage, addHolderHistory };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
const { html, data } = await buildHolderSnapshot(process.env.BLOCKSCOUT_API_KEY);
const output = new URL("../dist/", import.meta.url);

await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(new URL("index.html", output), html),
  writeFile(new URL("holders.json", output), JSON.stringify(data, null, 2) + "\n"),
]);
console.log(`Generated ${data.holders.length} holder rows at ${data.fetchedAt}.`);

}

