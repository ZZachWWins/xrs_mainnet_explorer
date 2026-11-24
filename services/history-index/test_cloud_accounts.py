"""Bounded first-activity metadata; synthetic public history only."""
import base64
import copy
import json
import unittest
from unittest.mock import patch

import cloud_archive as cloud
import history_index as history
import test_cloud_archive_independent as fixtures
from wire import b58


class AccountHistoryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.IndependentCloudArchiveTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.start()
        self.service = self.fixture.service

    def test_earliest_proposer_and_transaction_appearances_are_not_creation_claims(self):
        before = self.fixture.ledger.read_bytes()
        status, result = self.service.dispatch('/history/accounts')
        self.assertEqual(status, 200)
        self.assertEqual(result['basis'], 'earliest_indexed_activity')
        self.assertFalse(result['truncated'])
        self.assertIsNone(result['cursor'])
        values = {row['address']: row for row in result['data']}
        self.assertEqual(values[b58(bytes([1]) * 32)]['first_seen_slot'], 1)
        self.assertEqual(values[b58(bytes([2]) * 32)]['first_seen_slot'], 7)
        self.assertEqual(values[b58(bytes([3]) * 32)]['first_seen_timestamp_ms'], 1967000)
        self.assertTrue(all(set(row) == {'address', 'first_seen_slot', 'first_seen_timestamp_ms'} for row in values.values()))
        self.assertEqual(result['coverage']['chain_id'], 'xeris-mainnet-v4')
        self.assertEqual(result['snapshot_tip']['slot'], 8)
        self.assertEqual(self.fixture.ledger.read_bytes(), before)

    def test_pagination_has_no_duplicates_and_equal_slot_addresses_sort_stably(self):
        result = self.service.historical('accounts', limit=1)
        seen, cursors = [], []
        while True:
            seen.extend(result['data'])
            self.assertEqual(result['truncated'], result['cursor'] is not None)
            if result['cursor'] is None:
                break
            self.assertNotIn(result['cursor'], cursors)
            cursors.append(result['cursor'])
            status, result = self.service.dispatch('/history/accounts?cursor=' + result['cursor'])
            self.assertEqual(status, 200)
        self.assertEqual(len(seen), 3)
        self.assertEqual(len({row['address'] for row in seen}), 3)
        self.assertEqual(seen, sorted(seen, key=lambda row: (row['first_seen_slot'], row['address'])))

    def test_append_does_not_change_prior_page_snapshot(self):
        first = self.service.historical('accounts', limit=1)
        self.fixture.records.extend(fixtures.blocks(range(9, 11), self.fixture.records[-1]['hash'], branch=7, transaction_slot=9))
        self.fixture.ledger.write_bytes(fixtures.serialized(self.fixture.records))
        self.service.refresh()
        status, remaining = self.service.dispatch('/history/accounts?cursor=' + first['cursor'])
        self.assertEqual(status, 200)
        self.assertEqual(remaining['snapshot_tip']['slot'], 8)
        self.assertEqual(remaining['coverage']['tip']['slot'], 10)
        self.assertTrue(all(row['first_seen_slot'] <= 8 for row in remaining['data']))
        current = self.service.historical('accounts')
        self.assertIn(b58(bytes([8]) * 32), {row['address'] for row in current['data']})

    def test_shallow_reorg_removes_orphan_activity_and_expires_cursor(self):
        old = self.service.historical('accounts', limit=1)
        self.fixture.records = self.fixture.records[:6] + fixtures.blocks(range(7, 9), self.fixture.records[5]['hash'], branch=5, transaction_slot=7)
        self.fixture.ledger.write_bytes(fixtures.serialized(self.fixture.records))
        self.service.refresh()
        status, body = self.service.dispatch('/history/accounts?cursor=' + old['cursor'])
        self.assertEqual(status, 410)
        self.assertEqual(body['error']['code'], 'cursor_expired')
        addresses = {row['address'] for row in self.service.historical('accounts')['data']}
        self.assertNotIn(b58(bytes([2]) * 32), addresses)
        self.assertIn(b58(bytes([6]) * 32), addresses)

    def test_account_cursor_rejects_malformed_positions_and_other_route_cursors(self):
        original = self.service.historical('accounts', limit=1)['cursor']
        value = json.loads(base64.urlsafe_b64decode(original + '=' * (-len(original) % 4)))
        for before in ([True, value['before'][1]], [0, value['before'][1]], [1, 7], [1, '1' * 32], [1, 'invalid'], [1], None):
            changed = {**value, 'before': before}
            cursor = base64.urlsafe_b64encode(json.dumps(changed).encode()).decode().rstrip('=')
            self.assertEqual(self.service.dispatch('/history/accounts?cursor=' + cursor)[0], 400)
        block_cursor = self.service.historical('blocks', limit=1)['cursor']
        self.assertEqual(self.service.dispatch('/history/accounts?cursor=' + block_cursor)[0], 400)
        self.assertEqual(self.service.dispatch('/history/blocks?cursor=' + original)[0], 400)

    def test_system_address_excluded_and_missing_timestamp_is_null(self):
        index = history.Index(self.fixture.index_path)
        try:
            signature = index.db.execute('SELECT signature FROM transactions LIMIT 1').fetchone()[0]
            index.db.execute('INSERT INTO addresses VALUES(?,?)', ('1' * 32, signature))
            block = index.block(7)
            block['poh_timestamp'] = None
            index.db.execute('UPDATE blocks SET data=? WHERE slot=7', (json.dumps(block),))
            index.db.commit()
        finally:
            index.close()
        values = self.service.historical('accounts')['data']
        self.assertNotIn('1' * 32, {row['address'] for row in values})
        self.assertIsNone(next(row for row in values if row['first_seen_slot'] == 7)['first_seen_timestamp_ms'])

    def test_stale_history_stays_available_and_honest_without_affecting_other_networks(self):
        self.fixture.clock += 121
        status, result = self.service.dispatch('/history/accounts')
        self.assertEqual(status, 200)
        self.assertTrue(result['coverage']['stale'])
        self.assertEqual(result['coverage']['chain_id'], 'xeris-mainnet-v4')
        self.assertEqual(self.service.dispatch('/history/accounts?network=testnet')[0], 503)
        self.assertEqual(self.service.dispatch('/history/accounts', method='POST')[0], 405)

    def test_query_work_budget_fails_closed_without_poisoning_network_gate(self):
        with patch.object(cloud, 'ACCOUNT_QUERY_SECONDS', 0):
            self.assertEqual(self.service.dispatch('/history/accounts')[0], 503)
        self.assertFalse(self.service.failed)
        self.assertTrue(self.service.checkpoint()['success'])
        index = history.Index(self.fixture.index_path)
        try:
            signature = index.db.execute('SELECT signature FROM transactions LIMIT 1').fetchone()[0]
            index.db.executemany('INSERT INTO addresses VALUES(?,?)',
                                [(b58(i.to_bytes(32, 'big')), signature) for i in range(1, 501)])
            index.db.commit()
        finally:
            index.close()
        with patch.object(cloud, 'ACCOUNT_QUERY_VM_STEPS', 0):
            self.assertEqual(self.service.dispatch('/history/accounts')[0], 503)
        self.assertFalse(self.service.failed)

    def test_first_page_never_materializes_more_than_100_rows_and_marks_truncation(self):
        index = history.Index(self.fixture.index_path)
        try:
            signature = index.db.execute('SELECT signature FROM transactions LIMIT 1').fetchone()[0]
            index.db.executemany('INSERT INTO addresses VALUES(?,?)',
                                [(b58(i.to_bytes(32, 'big')), signature) for i in range(1, 151)])
            index.db.commit()
        finally:
            index.close()
        status, body = self.service.dispatch('/history/accounts')
        self.assertEqual(status, 200)
        self.assertEqual(len(body['data']), 100)
        self.assertTrue(body['truncated'])
        self.assertIsInstance(body['cursor'], str)


if __name__ == '__main__':
    unittest.main()
