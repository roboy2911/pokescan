// One-off check of the SoldComps API (eBay sold listings) for Australian sales.
// Run by the "Test AU sold prices" workflow, with the key in the SOLDCOMPS_API_KEY secret.
// Uses a handful of the plan's requests; never prints the key.
const KEY = process.env.SOLDCOMPS_API_KEY;
if (!KEY) { console.log('SOLDCOMPS_API_KEY secret is not set.'); process.exit(1); }
const keyword = process.env.KEYWORD || 'charizard 4/102';
const sites = (process.env.SITES || 'ebay.com.au').split(',');

for (const site of sites) {
  const url = new URL('https://api.sold-comps.com/v1/scrape');
  url.search = new URLSearchParams({ keyword, count: '20', daysToScrape: '90', ebaySite: site, ...(process.env.ITEM_LOCATION && { itemLocation: process.env.ITEM_LOCATION }) });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  console.log(`\n=== ebaySite=${site} itemLocation=${process.env.ITEM_LOCATION || '(default)'}: HTTP ${res.status}`);
  let body;
  try { body = JSON.parse(text); } catch { console.log(text.slice(0, 500)); continue; }
  const items = body.items ?? body.results ?? body.data ?? (Array.isArray(body) ? body : []);
  console.log('top-level keys:', Object.keys(body).join(', '));
  console.log('items:', Array.isArray(items) ? items.length : typeof items);
  if (Array.isArray(items) && items[0]) {
    console.log('item fields:', Object.keys(items[0]).join(', '));
    const count = (f) => Object.entries(items.reduce((m, it) => ((m[f(it)] = (m[f(it)] || 0) + 1), m), {}));
    console.log('totalItems:', body.totalItems, 'totalResults:', body.totalResults, 'hasNextPage:', body.hasNextPage);
    console.log('by currency:', JSON.stringify(count((it) => it.soldCurrency)));
    console.log('by location:', JSON.stringify(count((it) => it.itemLocation ?? '(none)')));
    for (const it of items.slice(0, 25)) {
      console.log('-', JSON.stringify([it.title, it.soldPrice, it.soldCurrency, it.shippingPrice, it.endedAt?.slice(0, 10),
        it.itemLocation, it.buyingFormat, it.condition]));
    }
  } else {
    console.log(JSON.stringify(body).slice(0, 800));
  }
}
