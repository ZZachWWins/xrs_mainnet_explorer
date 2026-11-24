import {createHistoryBlobAdapter} from '../../services/history-index/blobs.mjs';
import {createHistoryApiHandler} from '../../services/history-index/read-api.mjs';

// Direct read-only access to the activated immutable Mainnet snapshot.
// Requests cannot choose a network, store, token, source URL or write operation.
export function createHistorySnapshotFunction({adapter=createHistoryBlobAdapter({chainId:'xeris-mainnet-v4',storeName:'xeris-explorer-history'})}={}) {
  // The shared API accepts dot-free base paths; only this fixed public prefix maps.
  const publicPath='/.netlify/functions/history-snapshot',internalPath='/api/history-snapshot';
  const handle=createHistoryApiHandler({adapter,basePath:internalPath});
  return async request=>{
    const url=new URL(request.url);
    url.pathname=url.pathname.startsWith(publicPath+'/')?internalPath+url.pathname.slice(publicPath.length):'/unknown-snapshot-route';
    const result=await handle(new Request(url,request));
    const headers=new Headers(result.headers);
    headers.set('x-xeris-network','mainnet');
    headers.set('x-xeris-chain-id','xeris-mainnet-v4');
    return new Response(result.body,{status:result.status,headers});
  };
}
export default createHistorySnapshotFunction();
