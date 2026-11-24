import test from 'node:test';
import assert from 'node:assert/strict';
import {searchDestination} from '../src/navigation.mjs';
test('search routes exact identifiers without a remote discovery request',()=>{
  assert.equal(searchDestination(' 027201 '),'/block/27201');
  assert.equal(searchDestination('xeris_usdc'),'/token/xeris_usdc');
  assert.equal(searchDestination('xrs-xusdc-mainnet-v1'),'/contract/xrs-xusdc-mainnet-v1');
  assert.equal(searchDestination('plain','token'),'/token/plain');
  assert.equal(searchDestination('4p897nUzAxU9xbaQH69fa3S3hvtn9o1STiobHX4vnLoL'),'/account/4p897nUzAxU9xbaQH69fa3S3hvtn9o1STiobHX4vnLoL');
});
test('ambiguous, oversized, unsafe and malformed search terms remain in the form',()=>{
  for(const [value,scope] of [['plain','auto'],['<script>','token'],['../../path','contract'],['https://other.example','token'],['9007199254740992','block'],['0invalid','account'],['x'.repeat(129),'token']])assert.throws(()=>searchDestination(value,scope));
});
