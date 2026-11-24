"""Pure fixtures: no node files, network, signatures, or financial writes."""
import base64
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest
from unittest.mock import patch
import history_index as h
from wire import b58,short,decode,encode,merkle,json_safe,describe_instruction,work_hash


def raw_tx(seed=1, instructions=1):
    text=lambda s:struct.pack('<Q',len(s))+s.encode()
    sender=b58(bytes([seed])*32);receiver=b58(bytes([seed+1])*32)
    data=struct.pack('<I',11)+text(sender)+text(receiver)+struct.pack('<Q',2**63+1)
    wire=short(1)+bytes([seed])*64+bytes([1,0,0])+short(1)+bytes([seed])*32+bytes(32)+short(instructions)
    for _ in range(instructions):wire+=b'\0'+short(0)+short(len(data))+data
    return base64.b64encode(wire).decode()


def fixture(slot,parent='',seed=None,label='branch'):
    wires=[raw_tx(seed)] if seed is not None else []
    block={'slot':slot,'hash':hashlib.sha256(f'{label}:{slot}'.encode()).hexdigest(),'previous_hash':parent,
           'merkle_root':merkle([base64.b64decode(w) for w in wires]),'proposer':b58(bytes([1])*32)}
    return h.normalize_block(block,wires,'test')


def receipt(tx,slot,ok=True):
    return {'slot':slot,'meta':{'instructionOutcomes':[{'index':0,'ok':ok}],
            'err':None if ok else {'InstructionError':[0,'ExecutionFailed']}},'transaction':{'signatures':tx['signatures']}}


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.index=h.Index(Path(self.tmp.name)/'index.sqlite');self.addCleanup(self.index.close)
    def add(self,slot,seed=None):
        tip=self.index.coverage()['tip'];record=fixture(slot,tip['hash'] if tip else ('' if slot==1 else 'f'*64),seed)
        self.index.put(*record);return record
    def test_search_wire_address_and_large_amount(self):
        block,txs=self.add(1,1);tx=txs[0]
        self.assertEqual(self.index.search(block['hash'])['data']['slot'],1)
        self.assertEqual(self.index.search('1')['type'],'block')
        self.assertEqual(self.index.search(tx['signature'])['data']['status'],'unknown')
        self.assertEqual(self.index.transaction(tx['signature'])['wire_base64'],raw_tx(1))
        recipient=tx['instructions'][0]['decoded']['to']
        self.assertEqual(len(self.index.page('transactions',address=recipient)['data']),1)
        self.assertEqual(tx['instructions'][0]['decoded']['amount_raw'],str(2**63+1))
    def test_stable_cursor_during_append(self):
        for n in range(1,5):self.add(n,n)
        page=self.index.page('transactions',2)
        self.add(5,5)
        next_page=self.index.page('transactions',2,page['cursor'])
        self.assertEqual([r['slot'] for r in page['data']+next_page['data']],[4,3,2,1])
        self.assertEqual(next_page['snapshot_tip']['slot'],4)
    def test_address_pagination_no_duplicates(self):
        for n in range(1,5):self.add(n,n)
        page=self.index.page('transactions',1,address=b58(bytes([3])*32))
        more=self.index.page('transactions',1,page['cursor'],b58(bytes([3])*32))
        self.assertEqual([r['slot'] for r in page['data']+more['data']],[3,2])
        self.assertIsNone(more['cursor'])
    def test_reorg_replaces_indexes_and_invalidates_cursor(self):
        a,_=self.add(1,1);old,txs=self.add(2,2);self.add(3,3)
        cursor=self.index.page('blocks',1)['cursor']
        self.index.setmeta('observer_bounds',h.canonical({'from':1,'to':3,'blocks':3}));self.index.db.commit()
        b,bt=fixture(2,a['hash'],9,'new');c,ct=fixture(3,b['hash'],10,'new')
        self.index.replace_suffix(1,a['hash'],[(b,bt),(c,ct)])
        self.assertIsNone(self.index.block(old['hash']));self.assertIsNone(self.index.transaction(txs[0]['signature']))
        self.assertEqual(self.index.coverage()['revision'],1)
        self.assertIsNone(self.index.coverage()['observer_coverage'])
        with self.assertRaisesRegex(ValueError,'cursor'):self.index.page('blocks',1,cursor)
        self.assertEqual(self.index.db.execute('SELECT count(*) FROM reorgs').fetchone()[0],1)
    def test_bad_reorg_rolls_back(self):
        a,_=self.add(1,1);old,_=self.add(2,2)
        wrong,txs=fixture(2,'f'*64,9)
        with self.assertRaisesRegex(ValueError,'parent'):self.index.replace_suffix(1,a['hash'],[(wrong,txs)])
        self.assertEqual(self.index.block(2)['hash'],old['hash'])
    def test_gaps_are_disclosed(self):
        self.add(2,1);self.add(5,2)
        coverage=self.index.coverage();self.assertEqual(coverage['indexed_from'],2)
        self.assertFalse(coverage['genesis_block_present']);self.assertEqual(coverage['gaps'][0]['from'],3)
    def test_conflict_and_parent_mismatch(self):
        self.add(1,1)
        with self.assertRaisesRegex(ValueError,'parent'):self.index.put(*fixture(2,'f'*64,2))
        with self.assertRaisesRegex(ValueError,'conflict'):self.index.put(*fixture(1,'',2,'other'))
    def test_receipts_require_complete_matching_evidence(self):
        block,txs=self.add(1,1);tx=txs[0];r=receipt(tx,1)
        bad=json.loads(json.dumps(r));bad['meta']['err']={'InstructionError':[0,'ExecutionFailed']}
        with self.assertRaisesRegex(ValueError,'error/outcomes'):self.index.receipt(tx['signature'],bad,'test')
        bad=json.loads(json.dumps(r));bad['slot']=2
        with self.assertRaisesRegex(ValueError,'identity'):self.index.receipt(tx['signature'],bad,'test')
        self.index.receipt(tx['signature'],r,'three-node-observer');self.index.db.commit()
        self.assertEqual(self.index.transaction(tx['signature'])['status'],'confirmed')
        with self.assertRaisesRegex(ValueError,'conflicting'):self.index.receipt(tx['signature'],receipt(tx,1,False),'test')
    def test_readonly_receipts_and_unknown_when_missing(self):
        block,txs=self.add(1,1);path=Path(self.tmp.name)/'receipts.sqlite'
        db=sqlite3.connect(path);db.executescript('CREATE TABLE meta(k TEXT,v TEXT);CREATE TABLE ix_outcomes(signature TEXT,ix_index INTEGER,ok INTEGER,slot INTEGER);')
        db.executemany('INSERT INTO meta VALUES(?,?)',[('schema_version','2'),('tip_slot','1'),('tip_hash',block['hash'])]);db.commit();db.close()
        digest=hashlib.sha256(path.read_bytes()).digest();h.import_receipts(self.index,path)
        self.assertEqual(self.index.transaction(txs[0]['signature'])['status'],'unknown')
        self.assertEqual(digest,hashlib.sha256(path.read_bytes()).digest())
    def test_optional_wrong_branch_receipts_rejected_honestly(self):
        block,txs=self.add(1,1);path=Path(self.tmp.name)/'wrong-receipts.sqlite'
        db=sqlite3.connect(path);db.executescript('CREATE TABLE meta(k TEXT,v TEXT);CREATE TABLE ix_outcomes(signature TEXT,ix_index INTEGER,ok INTEGER,slot INTEGER);')
        db.executemany('INSERT INTO meta VALUES(?,?)',[('schema_version','2'),('tip_slot','1'),('tip_hash','f'*64)]);db.commit();db.close()
        source=h.readonly(path)
        try:h.optional_receipts(self.index,source)
        finally:source.close()
        self.assertEqual(self.index.transaction(txs[0]['signature'])['status'],'unknown')
        self.assertIsNone(self.index.coverage()['receipt_snapshot'])
        self.assertEqual(self.index.coverage()['receipt_snapshot_rejected']['outcomes_imported'],0)
    def test_receipt_import_serializes_anchor_check_against_writer(self):
        block,txs=self.add(1,1);tx=txs[0];path=Path(self.tmp.name)/'matching-receipts.sqlite'
        db=sqlite3.connect(path);db.executescript('CREATE TABLE meta(k TEXT,v TEXT);CREATE TABLE ix_outcomes(signature TEXT,ix_index INTEGER,ok INTEGER,slot INTEGER);CREATE TABLE receipts(id INTEGER,slot INTEGER,signature TEXT,tx_type TEXT,from_addr TEXT,to_addr TEXT,amount INTEGER,timestamp TEXT);')
        db.executemany('INSERT INTO meta VALUES(?,?)',[('schema_version','2'),('tip_slot','1'),('tip_hash',block['hash'])])
        db.execute('INSERT INTO ix_outcomes VALUES(?,?,?,?)',(tx['signature'],0,1,1))
        details=tx['instructions'][0]['decoded']
        db.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?)',(1,1,tx['signature'],'native_transfer',details['from'],details['to'],-2**63+1,'1234'));db.commit();db.close()
        other=h.Index(self.index.path);other.db.execute('PRAGMA busy_timeout=0');checked=[];original=h.validate_effects
        def probe(*args,**kwargs):
            with self.assertRaisesRegex(sqlite3.OperationalError,'locked'):
                other.db.execute("UPDATE metadata SET value=value WHERE key='chain_id'")
            other.db.rollback();checked.append(True);return original(*args,**kwargs)
        try:
            with patch.object(h,'validate_effects',probe):h.import_receipts(self.index,path)
        finally:other.close()
        self.assertEqual(checked,[True]);self.assertEqual(self.index.transaction(tx['signature'])['status'],'confirmed')
    def test_export_hashes_and_pages(self):
        for n in range(1,4):self.add(n,n)
        out=Path(self.tmp.name)/'export';manifest=h.export(self.index,out)
        self.assertEqual(manifest['indexed_from'],1)
        for f in manifest['files']:
            data=(out/f['path']).read_bytes();self.assertEqual(len(data),f['bytes']);self.assertEqual(hashlib.sha256(data).hexdigest(),f['sha256'])
        self.assertEqual(len(json.loads((out/'lists/blocks/1.json').read_text())['data']),3)
    def test_invalid_cursor_shapes_fail_closed(self):
        self.add(1)
        for c in ('%%%','W10',base64.urlsafe_b64encode(b'{"kind":"blocks"}').decode()):
            with self.assertRaises(ValueError):self.index.page('blocks',cursor=c)
    def test_ledger_backfill_headers_overlap_and_receipts(self):
        records=[];parent=[]
        for slot in (1,2,3):
            b={'slot':slot,'nonce':0,'poh_timestamp':1234+slot,'proposer':list(bytes([1])*32),
               'previous_hash':parent,'poh_hash':list(bytes([2])*32),'proposer_sig':[1],
               'merkle_root':list(bytes.fromhex(merkle([]))),'transactions':[]}
            b['hash']=list(bytes.fromhex(work_hash(b)));parent=b['hash'];records.append(b)
        checkpoint=bytes(records[1]['hash']).hex()
        self.index.put(*h.normalize_block(records[1],[],'test'))
        source=Path(self.tmp.name)/'ledger.dat';source.write_text(''.join(json.dumps(b)+'\n' for b in records))
        original=source.read_bytes()
        with patch.object(h,'CHECKPOINT_SLOT',2),patch.object(h,'CHECKPOINT_HASH',checkpoint):
            full=h.backfill_ledger(self.index,source,Path(self.tmp.name)/'full.sqlite')
            try:
                coverage=full.coverage();self.assertEqual(coverage['indexed_from'],1)
                self.assertEqual(coverage['counts']['blocks'],3)
                self.assertEqual(coverage['ledger_prefix']['header_commitments_recomputed'],3)
            finally:full.close()
            original_work=h.work_hash;changed=False
            def mutate_after_read(b):
                nonlocal changed
                result=original_work(b)
                if not changed:
                    changed=True;tampered=json.loads(json.dumps(records));tampered[0]['nonce']=1
                    source.write_text(''.join(json.dumps(v)+'\n' for v in tampered))
                return result
            with patch.object(h,'work_hash',mutate_after_read):
                with self.assertRaisesRegex(ValueError,'prefix changed'):
                    h.backfill_ledger(self.index,source,Path(self.tmp.name)/'rewritten.sqlite')
            records[0]['nonce']=1;source.write_text(''.join(json.dumps(b)+'\n' for b in records))
            with self.assertRaisesRegex(ValueError,'header commitment'):
                h.backfill_ledger(self.index,source,Path(self.tmp.name)/'tampered.sqlite')
        self.assertNotEqual(source.read_bytes(),original)
    def test_backfill_pins_receipts_before_ledger_scan(self):
        records=[];parent=[]
        for slot in (1,2,3):
            b={'slot':slot,'nonce':0,'poh_timestamp':1000+slot,'proposer':list(bytes([1])*32),
               'previous_hash':parent,'poh_hash':list(bytes([2])*32),'proposer_sig':[1],
               'merkle_root':list(bytes.fromhex(merkle([]))),'transactions':[]}
            b['hash']=list(bytes.fromhex(work_hash(b)));parent=b['hash'];records.append(b)
        checkpoint=bytes(records[1]['hash']).hex()
        self.index.put(*h.normalize_block(records[1],[],'test'))
        ledger=Path(self.tmp.name)/'live-ledger';ledger.write_text(''.join(json.dumps(b)+'\n' for b in records))
        receipts=Path(self.tmp.name)/'live-receipts';db=sqlite3.connect(receipts);db.execute('PRAGMA journal_mode=WAL')
        db.executescript('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT);CREATE TABLE ix_outcomes(signature TEXT,ix_index INTEGER,ok INTEGER,slot INTEGER);')
        db.executemany('INSERT INTO meta VALUES(?,?)',[('schema_version','2'),('tip_slot','2'),('tip_hash',checkpoint)]);db.commit()
        def advance(b):
            if b['slot']==1:
                db.execute("UPDATE meta SET v='3' WHERE k='tip_slot'")
                db.execute("UPDATE meta SET v=? WHERE k='tip_hash'",(bytes(records[2]['hash']).hex(),));db.commit()
            return work_hash(b)
        try:
            with patch.object(h,'CHECKPOINT_SLOT',2),patch.object(h,'CHECKPOINT_HASH',checkpoint),patch.object(h,'work_hash',advance):
                full=h.backfill_ledger(self.index,ledger,Path(self.tmp.name)/'pinned.sqlite',receipts)
                try:self.assertEqual(full.coverage()['receipt_snapshot']['tip_slot'],2)
                finally:full.close()
        finally:db.close()
    def test_incremental_ledger_tail_and_changed_prefix(self):
        records=[];parent=[]
        for slot in (1,2,3,4):
            b={'slot':slot,'nonce':0,'poh_timestamp':2000+slot,'proposer':list(bytes([1])*32),
               'previous_hash':parent,'poh_hash':list(bytes([2])*32),'proposer_sig':[1],
               'merkle_root':list(bytes.fromhex(merkle([]))),'transactions':[]}
            b['hash']=list(bytes.fromhex(work_hash(b)));parent=b['hash'];records.append(b)
        checkpoint=bytes(records[1]['hash']).hex();self.index.put(*h.normalize_block(records[1],[],'test'))
        path=Path(self.tmp.name)/'tail-ledger';serialize=lambda rows:''.join(json.dumps(b)+'\n' for b in rows)
        path.write_text(serialize(records[:2]))
        with patch.object(h,'CHECKPOINT_SLOT',2),patch.object(h,'CHECKPOINT_HASH',checkpoint):
            full=h.backfill_ledger(self.index,path,Path(self.tmp.name)/'tail.sqlite')
        try:
            path.write_text(serialize(records[:3]));result=h.append_ledger(full,path)
            self.assertEqual(result['records_checked'],1);self.assertEqual(full.coverage()['tip']['slot'],3)
            self.assertEqual(full.coverage()['ledger_prefix']['header_commitments_recomputed'],3)
            records[3]['nonce']=1;path.write_text(serialize(records))
            with self.assertRaisesRegex(ValueError,'header commitment'):h.append_ledger(full,path)
            self.assertEqual(full.coverage()['tip']['slot'],3)
            records[0]['nonce']=1;path.write_text(serialize(records[:3]))
            with self.assertRaisesRegex(ValueError,'retained ledger prefix changed'):h.append_ledger(full,path)
            self.assertEqual(full.coverage()['tip']['slot'],3)
        finally:full.close()
    def test_public_receipt_backup_includes_committed_wal(self):
        source=Path(self.tmp.name)/'wal-receipts';dest=Path(self.tmp.name)/'snapshot'
        db=sqlite3.connect(source);db.execute('PRAGMA journal_mode=WAL')
        db.executescript('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT);CREATE TABLE receipts(id INTEGER);CREATE TABLE receipt_addrs(id INTEGER);CREATE TABLE ix_outcomes(signature TEXT,ix_index INTEGER,ok INTEGER,slot INTEGER);')
        db.executemany('INSERT INTO meta VALUES(?,?)',[('schema_version','2'),('tip_slot','1'),('tip_hash','a'*64)]);db.execute("INSERT INTO ix_outcomes VALUES('publicsig',0,1,1)");db.commit()
        try:
            result=h.snapshot_receipts(source,dest);self.assertEqual(result['metadata']['tip_slot'],'1')
            snapshot=h.readonly(dest)
            try:self.assertEqual(snapshot.execute('SELECT count(*) FROM ix_outcomes').fetchone()[0],1)
            finally:snapshot.close()
            with self.assertRaisesRegex(ValueError,'must be new'):h.snapshot_receipts(source,dest)
        finally:db.close()
    def test_unrelated_database_is_rejected(self):
        path=Path(self.tmp.name)/'unrelated.sqlite';db=sqlite3.connect(path);db.execute('CREATE TABLE unrelated(x)');db.close()
        with self.assertRaisesRegex(ValueError,'unrelated'):h.Index(path)
    def test_observer_snapshot_and_digest(self):
        b,txs=fixture(1,'',1);tx=txs[0];path=Path(self.tmp.name)/'observer.sqlite'
        blocks={n:{**b,'transactions':[{'signature':tx['signature']}]} for n in h.NODES}
        e={'canonical_blocks_by_node':blocks,'raw_transactions_by_signature':{tx['signature']:tx['wire_base64']},'receipts_by_node':{n:{tx['signature']:receipt(tx,1)} for n in h.NODES}}
        data=h.canonical(e);db=sqlite3.connect(path);db.executescript('CREATE TABLE observer_metadata(key TEXT,value TEXT);CREATE TABLE observer_blocks(slot INTEGER,hash TEXT,previous_hash TEXT,evidence TEXT,digest TEXT);')
        binding={'schema':1,'chain':h.CHAIN,'nodes':h.NODES,'checkpoint_slot':h.CHECKPOINT_SLOT,'checkpoint_hash':h.CHECKPOINT_HASH}
        db.execute('INSERT INTO observer_metadata VALUES(?,?)',('binding',h.canonical(binding)));db.execute('INSERT INTO observer_blocks VALUES(?,?,?,?,?)',(1,b['hash'],'',data,hashlib.sha256(data.encode()).hexdigest()));db.commit();db.close()
        original=hashlib.sha256(path.read_bytes()).digest();h.import_observer(self.index,path)
        self.assertEqual(self.index.transaction(tx['signature'])['status'],'confirmed')
        self.assertEqual(original,hashlib.sha256(path.read_bytes()).digest())
        db=sqlite3.connect(path);db.execute("UPDATE observer_blocks SET digest='bad'");db.commit();db.close()
        with self.assertRaisesRegex(ValueError,'digest'):h.import_observer(self.index,path)


class WireTests(unittest.TestCase):
    def test_codec_roundtrip_sdk_json(self):
        encoded=raw_tx();tx,wire=decode(encoded);data=base64.b64decode(tx['instructions'][0]['data_base64'])
        vector=lambda values:[list(short(len(values))),*values]
        sdk={'signatures':vector([list(bytes([1])*64)]),'message':{'header':{'num_required_signatures':1,'num_readonly_signed_accounts':0,'num_readonly_unsigned_accounts':0},'account_keys':vector([list(bytes([1])*32)]),'recent_blockhash':list(bytes(32)),'instructions':vector([{'program_id_index':0,'accounts':vector([]),'data':vector(list(data))}])}}
        self.assertEqual(encode(sdk),encoded)
        m=sdk['message'];sdk['message']={'header':{'numRequiredSignatures':1,'numReadonlySignedAccounts':0,'numReadonlyUnsignedAccounts':0},'accountKeys':m['account_keys'],'recentBlockhash':m['recent_blockhash'],'instructions':[m['instructions'][0],{'programIdIndex':0,'accounts':vector([]),'data':vector(list(data))}]}
        self.assertEqual(encode(sdk),encoded)
    def test_truncated_and_merkle_mismatch(self):
        with self.assertRaises(ValueError):decode(raw_tx()[:-4])
        block,txs=fixture(1,'',1);block['merkle_root']='f'*64
        with self.assertRaisesRegex(ValueError,'Merkle'):h.normalize_block(block,[raw_tx()],'test')
    def test_noncanonical_shortvec(self):
        raw=base64.b64decode(raw_tx());bad=base64.b64encode(b'\x81\0'+raw[1:]).decode()
        with self.assertRaisesRegex(ValueError,'short'):decode(bad)
    def test_invalid_optional_argument_numbers_preserve_raw(self):
        text=lambda v:struct.pack('<Q',len(v))+v
        for args in (b'{"bad":NaN}',b'{"bad":1e999}',b'['*1200+b'0'+b']'*1200):
            raw=struct.pack('<I',4)+text(b'contract')+text(b'call')+text(args)
            value,_=describe_instruction(raw)
            self.assertNotIn('args_json',value)
            self.assertEqual(value['args_base64'],base64.b64encode(args).decode())
            h.canonical(value)
    def test_json_large_integers(self):self.assertEqual(json_safe({'x':2**64-1}),{'x':str(2**64-1)})

if __name__=='__main__':unittest.main()
