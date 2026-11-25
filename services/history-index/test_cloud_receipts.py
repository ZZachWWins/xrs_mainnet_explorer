"""Synthetic receipt enrichment and fixed read transport tests. No live RPC."""
import copy
import json
import sqlite3
import subprocess
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cloud_archive as cloud
import history_index as h
from wire import decode, encode
import test_cloud_archive_independent as fixtures

blocks, serialized = fixtures.blocks, fixtures.serialized


class ReceiptTests(unittest.TestCase):
    setUp = fixtures.IndependentCloudArchiveTests.setUp
    close_service = fixtures.IndependentCloudArchiveTests.close_service
    fetch = fixtures.IndependentCloudArchiveTests.fetch
    start = fixtures.IndependentCloudArchiveTests.start

    def transaction(self):
        return decode(encode(self.records[6]['transactions'][0]))[0]

    def observed(self, signature, slot, *, deadline):
        record = next(value for value in self.records if value['slot'] == slot)
        normalized, txs = h.normalize_block(record, [encode(tx) for tx in record['transactions']], 'fixture')
        tx = next(value for value in txs if value['signature'] == signature)
        return {'receipt': {'slot': slot, 'transaction': {'signatures': tx['signatures'], 'from': 'UNTRUSTED',
                'to': 'UNTRUSTED', 'amount': 999}, 'meta': {'err': None,
                'instructionOutcomes': [{'index': i, 'ok': True} for i in range(len(tx['instructions']))]}},
            'block': {'success': True, 'data': {'slot': slot, 'hash': normalized['hash'],
                'merkle_root': normalized['merkle_root'], 'transaction_count': len(txs),
                'transactions': [{'signature': value['signature']} for value in txs]}}}

    def test_existing_unknown_imports_only_verified_outcomes_and_survives_refresh(self):
        self.start(); signature = self.transaction()['signature']
        self.assertEqual(self.service.historical('transaction', signature)['data']['status'], 'unknown')
        self.service.fetch_receipt = self.observed
        self.service.refresh()
        value = self.service.historical('transaction', signature)['data']
        self.assertEqual(value['status'], 'confirmed')
        self.assertEqual(value['receipt']['source'], 'same-node-rpc-canonical-block')
        self.assertNotIn('from', value['receipt']['evidence']['transaction'])
        self.assertEqual(value['instructions'][0]['decoded']['amount_raw'], str(2**53 + 7))
        self.service.refresh()
        self.assertEqual(self.service.historical('transaction', signature)['data']['status'], 'confirmed')
        self.assertEqual(self.service.historical('coverage')['coverage']['execution_outcomes'], {'confirmed': 1})

    def test_missing_invalid_foreign_and_incomplete_evidence_stays_unknown(self):
        mutations = [lambda v: v.update(receipt=None, block=None),
            lambda v: v['receipt'].update(slot=8),
            lambda v: v['receipt']['transaction'].update(signatures=['other']),
            lambda v: v['receipt']['meta'].update(instructionOutcomes=[]),
            lambda v: v['receipt']['meta'].update(instructionOutcomes=[{'index': 0, 'ok': 1}]),
            lambda v: v['receipt']['meta'].update(err={'InstructionError': [0, 'ExecutionFailed']}),
            lambda v: v['block']['data'].update(hash='f'*64),
            lambda v: v['block']['data'].update(merkle_root='f'*64),
            lambda v: v['block']['data'].update(transactions=[]),
            lambda v: v['block'].update(success=False)]
        self.start(); signature = self.transaction()['signature']
        for mutate in mutations:
            def fetch(*args, **kwargs):
                value = self.observed(*args, **kwargs); mutate(value); return value
            self.service.fetch_receipt = fetch
            self.service.refresh()
            self.assertEqual(self.service.historical('transaction', signature)['data']['status'], 'unknown')
            self.assertEqual(self.service.dispatch('/health')[0], 200)

    def test_failed_execution_is_not_marked_confirmed(self):
        def fetch(*args, **kwargs):
            value = self.observed(*args, **kwargs)
            value['receipt']['meta'] = {'instructionOutcomes': [{'index': 0, 'ok': False}],
                'err': {'InstructionError': [0, 'ExecutionFailed']}}
            return value
        self.service.fetch_receipt = fetch; self.start()
        self.assertEqual(self.service.historical('transaction', self.transaction()['signature'])['data']['status'], 'failed')

    def test_old_unknowns_rotate_past_missing_newest_and_batch_is_bounded(self):
        self.start()
        for slot in range(9, 15):
            self.records.extend(blocks([slot], self.records[-1]['hash'], branch=slot, transaction_slot=slot))
        self.ledger.write_bytes(serialized(self.records))
        calls = []
        def fetch(signature, slot, **kwargs):
            calls.append(slot)
            return {'receipt': None, 'block': None} if slot >= 11 else self.observed(signature, slot, **kwargs)
        self.service.fetch_receipt = fetch
        self.service.refresh(); self.assertEqual(calls, [14, 13, 12, 11])
        calls.clear(); self.service.refresh(); self.assertEqual(calls, [10, 9, 7])
        self.assertEqual(self.service.historical('transaction', self.transaction()['signature'])['data']['status'], 'confirmed')
        calls.clear(); self.service.refresh(); self.assertEqual(calls, [14, 13, 12, 11])

    def test_source_mutation_during_receipt_fetch_rolls_back_outcome_import(self):
        self.start()
        def fetch(*args, **kwargs):
            result = self.observed(*args, **kwargs)
            content = self.ledger.read_bytes().replace(b'"nonce":1', b'"nonce":2', 1)
            self.ledger.write_bytes(content)
            return result
        self.service.fetch_receipt = fetch
        with self.assertRaises(ValueError): self.service.refresh()
        self.assertEqual(self.service.historical('transaction', self.transaction()['signature'])['data']['status'], 'unknown')

    def test_receipt_query_interrupt_is_optional_and_preserves_cursor(self):
        self.start(); self.service.fetch_receipt = self.observed
        index = h.Index(self.index_path)
        try:
            # Force the real SQLite progress handler to interrupt its SELECT.
            with patch('cloud_archive.time.monotonic', side_effect=[10, 20]), patch('cloud_archive.RECEIPT_SECONDS', 0.00001):
                # A separate large scan guarantees progress callbacks execute.
                with h.atomic(index.db):
                    row = index.db.execute('SELECT * FROM transactions').fetchone()
                    known = json.loads(row['data']); known['status'] = 'confirmed'
                    index.db.executemany('INSERT INTO transactions VALUES(?,?,?,?)',
                        [('synthetic'+str(n), row['slot'], n+1, h.canonical(known)) for n in range(3000)])
                updates, status = self.service.receipt_updates(index, 20)
            self.assertEqual(updates, []); self.assertTrue(status['query_budget_exhausted'])
            self.assertIsNone(status['cursor'])
        finally: index.close()


class ReceiptTransportTests(unittest.TestCase):
    def test_fixed_child_deadline_and_no_redirectable_url_input(self):
        reply = b'{"receipt":null,"block":null}'
        with patch('cloud_archive.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=reply)) as run:
            self.assertEqual(cloud.fetch_receipt('2'*88, 7, deadline=time.monotonic()+5), {'receipt': None, 'block': None})
            args, kwargs = run.call_args
            self.assertEqual(args[0][-1], '--read-receipt'); self.assertLessEqual(kwargs['timeout'], 1)
            self.assertEqual(json.loads(kwargs['input']), {'signature': '2'*88, 'slot': 7})
            self.assertNotIn('HTTP_PROXY', kwargs['env'])
        with patch('cloud_archive.subprocess.run') as run, self.assertRaises(ValueError):
            cloud.fetch_receipt('http://attacker.invalid', 7, deadline=time.monotonic()+1)
        run.assert_not_called()

    def test_child_timeout_and_oversize_fail_without_retry(self):
        with patch('cloud_archive.subprocess.run', side_effect=subprocess.TimeoutExpired('child', 1)) as run:
            with self.assertRaises(subprocess.TimeoutExpired): cloud.fetch_receipt('2'*88, 7, deadline=time.monotonic()+1)
            self.assertEqual(run.call_count, 1)
        with patch('cloud_archive.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=b'x'*(cloud.RECEIPT_RESPONSE*2+129))):
            with self.assertRaises(ValueError): cloud.fetch_receipt('2'*88, 7, deadline=time.monotonic()+1)


if __name__ == '__main__': unittest.main()
