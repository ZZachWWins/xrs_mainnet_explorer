import {createArchivePublisher} from '../../src/archive-publisher.mjs';

// Reviewed public archive only. Updating this checkpoint is a source change,
// not something an HTTP caller, deploy payload, or mutable source can request.
export const INITIAL_ARCHIVE = Object.freeze({
  generation: 'ebc06372059108107e3374717156c6ae7b4f27f0e98efb4c589dc79e5ee31158',
  manifestSha256: '6bec6493c7ca09d38f3236d9ac0085bd09015ca250cdc8307ff902dc5b70c7fe',
  canonicalManifestSha256: 'bed9540f01f6d9b45eb6da724f467b1d1adfa5c7f05e0244efdcdd44b5971b72',
  manifestBytes: 81156,
  files: 640,
  bytes: 46814066,
  tipSlot: 50257,
  tipHash: '0bb9985978bde3f674e9fd25ed4fea0649473d16002fe0b30c19abad649932fd',
  indexedFrom: 1,
});

const publish = createArchivePublisher({archive: INITIAL_ARCHIVE});

// Platform events are JWS-verified by Netlify and execute in the background.
// Deliberately no fetch handler, public write route, or arbitrary upload body.
export default {
  async deploySucceeded(event) {
    try {
      const result = await publish(event);
      console.info(JSON.stringify({archive_publication: result}));
    } catch {
      // Never log SDK errors, request headers, credentials, or response bodies.
      throw new Error('Initial history archive publication failed; activation was not confirmed');
    }
  },
};
