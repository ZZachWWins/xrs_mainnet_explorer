"""Independent public-fixture receipt enrichment review; no network/node writes."""
import copy
import sqlite3
import subprocess
import time
import unittest
from unittest.mock import patch

import cloud_archive as cloud
import history_index as history
import test_cloud_archive_independent as fixtures
from wire import decode, encode, b58


class IndependentReceiptTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.IndependentCloudArchiveTests(methodName='runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.f=self.fixture;self.tx,_=decode(encode(self.f.records[6]['transactions'][0]));self.signature=self.tx['signature']
    def value(self):
        index=history.Index(self.f.index_path)
        try:
            tx=index.transaction(self.signature);block=index.block(tx['slot'])
            return {'receipt':{'slot':tx['slot'],'transaction':{'signatures':tx['signatures']},'meta':{'err':None,'instructionOutcomes':[{'index':0,'ok':True}]}},'block':{'success':True,'data':{key:block[key] for key in ('slot','hash','merkle_root','transaction_count')}|{'transactions':[{'signature':sig} for sig in block['transactions']]}}}
        finally:index.close()
    def stored(self):
        index=history.Index(self.f.index_path)
        try:return index.transaction(self.signature)
        finally:index.close()
    def test_valid_outcomes_survive_unchanged_overlap_and_preserve_exact_wire(self):
        original=self.f.ledger.read_bytes();value=self.value();self.f.service.fetch_receipt=lambda *args,**kwargs:copy.deepcopy(value);self.f.start()
        stored=self.stored();self.assertEqual(stored['status'],'confirmed');self.assertEqual(stored['wire_base64'],self.tx['wire_base64']);self.assertEqual(stored['receipt']['source'],'same-node-rpc-canonical-block')
        self.f.service.refresh();self.assertEqual(self.stored()['status'],'confirmed');self.assertEqual(self.f.ledger.read_bytes(),original)
    def test_wrong_receipt_identity_outcome_or_canonical_header_stays_unknown_and_gate_healthy(self):
        self.f.start()
        variants=[lambda v:v['receipt'].__setitem__('slot',8),lambda v:v['receipt']['transaction'].__setitem__('signatures',['wrong']),lambda v:v['receipt']['meta'].__setitem__('err',False),lambda v:v['receipt']['meta']['instructionOutcomes'][0].__setitem__('index',1),lambda v:v['block']['data'].__setitem__('hash','f'*64),lambda v:v['block']['data'].__setitem__('merkle_root','f'*64),lambda v:v['block']['data']['transactions'][0].__setitem__('signature','wrong')]
        for change in variants:
            value=self.value();change(value);self.f.service.fetch_receipt=lambda *args,_value=value,**kwargs:copy.deepcopy(_value)
            with self.subTest(change=change):
                self.f.service.refresh();self.assertEqual(self.stored()['status'],'unknown');self.assertTrue(self.f.service.checkpoint()['success'])
    def test_rpc_effects_and_unvalidated_addresses_are_never_imported(self):
        unrelated=b58(bytes([20])*32);payload=self.value()
        def fetch(*args,**kwargs):
            value=copy.deepcopy(payload);value['receipt']['transaction'].update({'from':unrelated,'to':unrelated,'amount':999});return value
        self.f.service.fetch_receipt=fetch;self.f.start();tx=self.stored();self.assertEqual(set(tx['receipt']['evidence']['transaction']),{'signatures'})
        index=history.Index(self.f.index_path)
        try:self.assertEqual(index.db.execute('SELECT COUNT(*) FROM addresses WHERE address=?',(unrelated,)).fetchone()[0],0)
        finally:index.close()
    def test_missing_receipt_and_child_timeout_do_not_invent_success_or_invalidate_blocks(self):
        self.f.start();self.f.service.fetch_receipt=lambda *args,**kwargs:{'receipt':None,'block':None};self.f.service.refresh();self.assertEqual(self.stored()['status'],'unknown')
        def timeout(*args,**kwargs):raise subprocess.TimeoutExpired('fixed-read-child',1)
        self.f.service.fetch_receipt=timeout;self.f.service.refresh();self.assertEqual(self.stored()['status'],'unknown');self.assertTrue(self.f.service.checkpoint()['success'])
    def test_source_rewrite_during_receipt_fetch_rolls_back_import_and_disables_pin(self):
        self.f.start();payload=self.value()
        def fetch(*args,**kwargs):
            value=copy.deepcopy(payload);raw=bytearray(self.f.ledger.read_bytes());raw[0]=ord('[');self.f.ledger.write_bytes(raw);return value
        self.f.service.fetch_receipt=fetch
        with self.assertRaises(ValueError):self.f.service.refresh()
        self.assertEqual(self.stored()['status'],'unknown')
        with self.assertRaises(ValueError):self.f.service.checkpoint()
    def test_real_sqlite_interrupt_is_optional_and_retains_rotation_cursor(self):
        self.f.start();index=history.Index(self.f.index_path);original=index.db
        class BudgetDB:
            def __getattr__(inner,key):return getattr(original,key)
            def set_progress_handler(inner,callback,steps):
                # A genuine SQLite SQLITE_INTERRUPT, not a mocked HTTP timeout.
                original.set_progress_handler((lambda:1) if callback is not None else None,1 if callback is not None else 0)
        cursor=[7,0,self.signature];index.setmeta('cloud_receipt_cursor',history.canonical(cursor));index.db=BudgetDB();self.f.service.fetch_receipt=lambda *args,**kwargs:self.fail('SQL budget must stop before RPC')
        try:
            updates,telemetry=self.f.service.receipt_updates(index,time.monotonic()+4)
            self.assertEqual(updates,[]);self.assertTrue(telemetry['query_budget_exhausted']);self.assertEqual(telemetry['cursor'],cursor)
        finally:original.set_progress_handler(None,0);index.db=original;index.close()
    def test_expired_parent_deadline_never_starts_read_child(self):
        with patch('cloud_archive.subprocess.run') as run:
            with self.assertRaises(ValueError):cloud.fetch_receipt(self.signature,7,deadline=time.monotonic()-1)
            run.assert_not_called()

if __name__=='__main__':unittest.main()
