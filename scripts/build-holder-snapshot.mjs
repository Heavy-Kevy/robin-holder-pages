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

async function fetchIndexedSupply(apiKey) {
  for (const url of blockscoutSources(tokenPath, apiKey)) {
    try {
      const upstream = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(3500),
      });
      if (!upstream.ok) continue;
      const token = await upstream.json();
      const supply = token?.total_supply;
      if (token?.address_hash?.toLowerCase() === contract.toLowerCase()
        && String(token.decimals) === "18"
        && typeof supply === "string" && /^\d{1,78}$/.test(supply) && BigInt(supply) > 0n) {
        return supply;
      }
    } catch {
      // Try the next source. Holder balances can still be served without supply.
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
    return `<tr role="row">
      <td class="rank" role="cell"><span class="mobile-label" aria-hidden="true">Rank</span>${rank}</td>
      <th class="holder-address" scope="row" role="rowheader"><a class="wallet" href="${explorer}">${address}</a></th>
      <td class="wallet-label" role="cell"><span class="mobile-label" aria-hidden="true">Wallet label</span>${label ? `<a href="${label.source}">${label.name}</a>` : "—"}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">Balance (ROBIN)</span>${formatRoundedUnits(units, 18, 2)}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">% of total supply</span>${share}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">First held (UTC)</span>${firstHeldAt ? `<a href="${firstHeldTransaction}" title="First recorded positive ROBIN receipt">${firstHeldAt.slice(0, 10)}</a>` : "Unavailable"}</td>
      <td class="balance" role="cell"><span class="mobile-label" aria-hidden="true">24h change (ROBIN)</span>${signedChange(change24h)}</td>
      <td class="balance value" role="cell"${!quote && !isBurn ? ` data-robin-units="${units}"` : ""}><span class="mobile-label" aria-hidden="true">Est. value (USDG)</span><span class="value-amount">${usdGValue}</span></td>
    </tr>`;
  }).join("");
  const content = `
    <p class="status">Last updated <time datetime="${data.fetchedAt}">${data.fetchedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC")}</time></p>
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
<meta name="description" content="Scheduled snapshot of balances for the top 50 ROBIN holder addresses on Robinhood Chain.">
<title>Top 50 ROBIN holders</title>
<style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101b16;color:#edf7ef}
  *{box-sizing:border-box}
  body{margin:0}
  main{max-width:92rem;margin:auto;padding:clamp(1rem,4vw,3rem)}
  header{background:#192c21;border:1px solid #355442;border-radius:1rem;padding:clamp(1.15rem,4vw,2.5rem)}
  .chain{margin:0;color:#a9dea9;font-size:.9rem}
  h1{margin:.35rem 0;font-size:clamp(1.9rem,6vw,3.45rem);line-height:1.05;letter-spacing:-.035em}
  p{line-height:1.5}
  .intro,.status{color:#c2d7c8}
  nav{display:flex;flex-wrap:wrap;gap:.65rem 1.25rem;margin-top:1rem}
  a{color:#b6efaa;text-underline-offset:.22em}
  a:hover{color:#e7ffd9}
  :focus-visible{outline:2px solid #b6efaa;outline-offset:3px}
  .live-link{display:inline-block;padding:.55rem .9rem;border-radius:.5rem;background:#b6efaa;color:#101b16;font-weight:700;text-decoration:none}
  .live-link:hover{background:#e7ffd9;color:#101b16;text-decoration:underline}
  nav{align-items:center}
  .status{font-size:.875rem;margin:1.1rem 0 .65rem}
  .quote{color:#c2d7c8;font-size:.875rem;margin:0 0 .75rem}
  .unavailable{padding:1rem;border:1px solid #355442;border-radius:.75rem}
  .table-region{overflow-x:auto;border:1px solid #355442;border-radius:.75rem}
  table{width:100%;min-width:74rem;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}
  th,td{padding:.75rem 1rem;border-bottom:1px solid #304337;vertical-align:top}
  thead{background:#243b2d}
  tbody tr:nth-child(even){background:#17251d}
  tbody tr:last-child>*{border-bottom:0}
  tbody th{font-weight:400}
  td:first-child{width:4.5rem;color:#c2d7c8}
  .wallet{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
  .balance{text-align:right;overflow-wrap:anywhere}
  .mobile-label{display:none}
  @media(max-width:76rem){
    .live-link{display:inline-flex;align-items:center;min-height:44px}
    .table-region{border:0;overflow:visible}
    table,tbody{display:block;min-width:0}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem 1rem;margin-bottom:.75rem;padding:1rem;border:1px solid #355442;border-radius:.75rem;background:#192c21}
    tbody :is(th,td){display:block;min-width:0;padding:0;border:0;text-align:left}
    tbody .rank{width:auto;font-weight:700}
    .holder-address,.wallet-label,.rank{grid-column:1/-1}
    .holder-address{overflow-wrap:anywhere}
    .mobile-label{display:block;margin-bottom:.2rem;color:#c2d7c8;font-size:.875rem}
    .rank .mobile-label{display:inline;margin:0 .35rem 0 0}
  }
</style>
</head>
<body>
<main>
  <header>
    <p class="chain">Robinhood Chain</p>
    <h1>Top 50 ROBIN holders</h1>
    <p class="intro">Wallet and contract addresses ranked by token balance. This snapshot is scheduled to refresh hourly.</p>
    <nav aria-label="Data sources"><a class="live-link" href="${holdersPage}">View live on Blockscout</a><a href="./holders.json">Raw JSON</a></nav>
  </header>
  ${content}
</main>
${!quote ? quoteFallbackScript() : ""}
</body>
</html>`;
}

async function fetchHolderData(apiKey) {
  const supplyPromise = fetchIndexedSupply(apiKey);
  const sources = blockscoutSources(`${tokenPath}/holders`, apiKey);

  for (const url of sources) {
    try {
      const upstream = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(7000),
      });
      if (!upstream.ok) continue;

      const payload = await upstream.json();
      const rows = payload.items?.slice(0, holderLimit);
      if (rows?.length !== holderLimit || rows.some(({ address, value }) =>
        !/^0x[a-f0-9]{40}$/i.test(address?.hash ?? "") ||
        typeof value !== "string" || !/^\d{1,78}$/.test(value) || BigInt(value) === 0n
      )) continue;

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
      return data;
    } catch {
      // Try the next Blockscout endpoint, then report unavailability.
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
