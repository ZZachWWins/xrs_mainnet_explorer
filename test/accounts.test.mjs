import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAccountAges,validateAccountPrice,accountUSD,sortAccounts,accountFirstSeen} from '../src/accounts.mjs';
import {createExplorerAPI} from '../src/explorer-api.mjs';
import {routeRequest} from '../src/proxy.mjs';
const now=1795561609448;
const quote={numerator:'20101886',denominator:'1412242079735',observedAtMs:String(now),expiresAtMs:String(now+20000)};
const feed={schema_version:'2',chain_id:'xeris-mainnet-v4',status:'ready',observed_at_ms:quote.observedAtMs,expires_at_ms:quote.expiresAtMs,
  market:{token_id:'native_xrs',decimals:'9',quote_token_id:'xeris_usdc',quote_decimals:'6',price_pool_id:'xrs-xusdc-mainnet-v1',price_basis:'pool_spot',price_quote_raw_numerator:quote.numerator,price_xrs_raw_denominator:quote.denominator}};
const a='4p897nUzAxU9xbaQH69fa3S3hvtn9o1STiobHX4vnLoL',b='6Vci5FsC9YAdHQo74ARMME7RA25ab4chfFzAv3UMb7tw';
const ages={basis:'earliest_indexed_activity',generation:'a'.repeat(64),coverage:{chain_id:'xeris-mainnet-v4',indexed_from:1,tip:{slot:52200}},truncated:false,
  data:[{address:a,first_seen_slot:1,first_seen_timestamp_ms:now-100000},{address:b,first_seen_slot:32924,first_seen_timestamp_ms:now-50000}]};
test('USD estimates use exact raw balances and verified reserve ratio, including tiny and zero values',()=>{
  assert.equal(accountUSD('198999000000',quote,now),'$2.83');
  assert.equal(accountUSD('200165828090408815',quote,now),'$2,849,164.97');
  assert.equal(accountUSD('96000000',quote,now),'<$0.01');
  assert.equal(accountUSD('0',quote,now),'$0.00');
  assert.equal(accountUSD(200165828090408815,quote,now),null);
  assert.equal(accountUSD('18446744073709551616',quote,now),null);
});
test('quotes expire without another network response and invalid prices never become zero',()=>{
  assert.deepEqual(validateAccountPrice(feed,now),quote);
  assert.equal(accountUSD('198999000000',quote,now+19999),'$2.83');
  assert.equal(accountUSD('198999000000',quote,now+20000),null);
  for(const changed of [{chain_id:'testnet'},{expires_at_ms:String(now)},{expires_at_ms:String(now+20001)},{observed_at_ms:String(now+2001)},
    {market:{...feed.market,price_xrs_raw_denominator:'0'}},{market:{...feed.market,quote_token_id:'unverified'}},{market:{...feed.market,price_basis:'fixed'}}])
    assert.throws(()=>validateAccountPrice({...feed,...changed},now));
});
test('default order is oldest recorded activity regardless of balances; unknown age is last in both directions',()=>{
  const entries=[[b,'2000000000000'],['unknown','99999999999999999'],[a,'1']];
  assert.deepEqual(sortAccounts(entries,ages.data).map(v=>v[0]),[a,b,'unknown']);
  assert.deepEqual(sortAccounts(entries,ages.data,'age','desc').map(v=>v[0]),[b,a,'unknown']);
  assert.deepEqual(sortAccounts(entries,ages.data,'balance','desc').map(v=>v[0]),['unknown',b,a]);
  assert.deepEqual(entries[0],[b,'2000000000000']);
});
test('age metadata must bind to mainnet coverage and preserves missing dates honestly',()=>{
  assert.equal(validateAccountAges(ages).data[1].first_seen_slot,32924);
  assert.match(accountFirstSeen(ages.data[0]),/2026.*UTC$/);
  assert.equal(accountFirstSeen(null),'Unavailable');
  const withoutDate={...ages.data[0],first_seen_timestamp_ms:null};
  assert.equal(validateAccountAges({...ages,data:[withoutDate]}).data[0].first_seen_slot,1);
  assert.equal(accountFirstSeen(withoutDate),'Block 1');
  for(const changed of [{coverage:{...ages.coverage,chain_id:'testnet'}},{data:[ages.data[0],ages.data[0]]},{data:[{...ages.data[0],first_seen_slot:60000}]},
    {data:[{...ages.data[0],first_seen_timestamp_ms:NaN}]},{basis:'creation'}]) assert.throws(()=>validateAccountAges({...ages,...changed}));
});
test('Testnet never queries Mainnet pricing or account age routes',async()=>{
  let calls=0;const api=createExplorerAPI('testnet',{fetchImpl:async()=>{calls++;throw Error('not allowed');}});
  assert.equal(await api.accountPrice(),null);assert.deepEqual(await api.accountAges(),{data:[],basis:'unavailable',truncated:false});assert.equal(calls,0);
});
test('age proxy exposes only the fixed mainnet readonly endpoint without query overrides',()=>{
  assert.equal(routeRequest('/networks/mainnet/history/accounts').url,'https://mainnetrpc.xerisweb.com/history/accounts');
  for(const path of ['/networks/testnet/history/accounts','/networks/mainnet/history/accounts?limit=100','/networks/mainnet/history/accounts?after=x'])assert.throws(()=>routeRequest(path));
  assert.throws(()=>routeRequest('/networks/mainnet/history/accounts','POST','{}'));
});
