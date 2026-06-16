// Customer -> marketplace topology (ported from FlyApp config/erpCustomers.js).
//
// ListingApp models products per customer (Amazon US, Amazon EU, ...). A
// single Amazon-EU customer's ASIN fans out to GB/DE/FR/IT/ES. This map lets
// the push service expand one ListingApp customer into the set of Amazon
// marketplaces its listings should be pushed to.
const CUSTOMER_MARKETPLACES = [
  { customer_id: 1,  name: 'Amazon Canada',   marketplaces: ['CA'] },
  { customer_id: 2,  name: 'Amazon US',       marketplaces: ['US'] },
  { customer_id: 3,  name: 'Amazon Emerging', marketplaces: ['AU', 'AE', 'SA'] },
  { customer_id: 4,  name: 'Amazon EU',       marketplaces: ['GB', 'DE', 'FR', 'IT', 'ES'] },
  { customer_id: 5,  name: 'Walmart US',      marketplaces: ['US'] },
  { customer_id: 14, name: 'Target US',       marketplaces: ['US'] }
];

const byCustomerId = new Map(CUSTOMER_MARKETPLACES.map((c) => [c.customer_id, c]));

function marketplacesForCustomer(customerId) {
  const row = byCustomerId.get(Number(customerId));
  return row ? row.marketplaces.slice() : [];
}

module.exports = { CUSTOMER_MARKETPLACES, marketplacesForCustomer };
