import {createHistoryBlobAdapter} from '../../services/history-index/blobs.mjs';
import {createHistoryApiHandler} from '../../services/history-index/read-api.mjs';

// Fixed public Mainnet namespace. No request can choose a network, store or token.
export function createHistoryFunction({adapter = createHistoryBlobAdapter({chainId: 'xeris-mainnet-v4'})} = {}) {
  const handle = createHistoryApiHandler({adapter, basePath: '/api/history'});
  return async request => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/.netlify/functions/history/')) {
      url.pathname = '/api/history/' + url.pathname.slice('/.netlify/functions/history/'.length);
      request = new Request(url, request);
    }
    const result = await handle(request);
    const headers = new Headers(result.headers);
    headers.set('x-xeris-network', 'mainnet');
    headers.set('x-xeris-chain-id', 'xeris-mainnet-v4');
    return new Response(result.body, {status: result.status, headers});
  };
}
export default createHistoryFunction();
