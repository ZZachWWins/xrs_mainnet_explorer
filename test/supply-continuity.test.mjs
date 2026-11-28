import test from 'node:test';
import assert from 'node:assert/strict';
import {createExplorerAPI} from '../src/explorer-api.mjs';
import {NETWORKS} from '../src/network.mjs';

function fixture() {
  let clock=10_000, mode='ready';
  const feed={schema_version:'2',chain_id:'xeris-mainnet-v4',status:'ready',
    expires_at_ms:'30000',observed_at:'2026-11-24T22:00:00Z',
    supply:{basis:'unlocked_on_chain_v2',circulating_raw:'200165828090408815'}};
  const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'x-xeris-network':'mainnet','x-xeris-chain-id':NETWORKS.mainnet.chainId}});
  const api=createExplorerAPI('mainnet',{now:()=>clock,fetchImpl:async path=>{
    if(path.endsWith('/identity/checkpoint'))return reply({success:true,data:{slot:27201,hash:NETWORKS.mainnet.checkpointHash}});
    if(path.endsWith('/v2/stats'))return reply({success:true,data:{current_slot:51000,validator_count:3}});
    if(mode==='offline')throw new TypeError('Temporary transport interruption');
    if(mode==='busy')return reply({},503);
    if(mode==='wrong-chain')return reply({...feed,chain_id:'xeris-testnet'});
    if(mode==='malformed')return reply({...feed,supply:{circulating_raw:'invented'}});
    return reply(feed);
  }});
  return {api,setClock:value=>{clock=value;},setMode:value=>{mode=value;},feed};
}

test('short transport outages keep the last exact circulation visible after its original live window',async()=>{
  for(const mode of ['offline','busy']){
    const f=fixture(),first=await f.api.stats();
    assert.equal(first.circulating_supply,'200165828090408815');
    f.setMode(mode);f.setClock(20_000);
    const retained=await f.api.stats();
    assert.equal(retained.circulating_supply,first.circulating_supply);
    assert.equal(retained.supply_observed_at,f.feed.observed_at);
    f.setClock(30_000);
    assert.equal(retained.circulating_supply,first.circulating_supply);
    const later=await f.api.stats();assert.equal(later.circulating_supply,first.circulating_supply);assert.equal(later.supply_stale,true);
  }
});

test('wrong-chain or malformed supply immediately clears a still-valid previous observation',async()=>{
  for(const mode of ['wrong-chain','malformed']){
    const f=fixture();await f.api.stats();f.setMode(mode);
    assert.equal((await f.api.stats()).circulating_supply,undefined);
    f.setMode('offline');
    assert.equal((await f.api.stats()).circulating_supply,undefined);
  }
});

test('a new verified feed replaces the old observation without mutating retained view data',async()=>{
  const f=fixture(),first=await f.api.stats();
  f.feed.supply.circulating_raw='200165838090408815';f.feed.expires_at_ms='40000';f.setClock(20_000);
  const next=await f.api.stats();assert.equal(next.circulating_supply,'200165838090408815');
  assert.equal(first.circulating_supply,'200165828090408815');
  f.setClock(30_000);assert.equal(first.circulating_supply,'200165828090408815');
  assert.equal(next.circulating_supply,'200165838090408815');
});
