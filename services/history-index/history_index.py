"""Independent public explorer index. All source databases are opened read-only.

No validator imports, network calls, private files, signing, or node writes.
Canonical means matching the supplied node/observer evidence, not independent
consensus validation. Unknown execution outcomes remain unknown.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from contextlib import contextmanager
from wire import decode, encode, merkle, work_hash, octets, b58, json_safe, require
from receipt_effects import validate_effects

CHAIN='xeris-mainnet-v4'
CHECKPOINT_SLOT=27201
CHECKPOINT_HASH='0a401c139eef73f049010450d4aa13ef38636799784d01bbc0ecdb9c71facaf3'
NODES=['droplet','mac_auxiliary','mac_treasury']
HEX=re.compile(r'^[0-9a-f]{64}$')
PAGE_SIZE=100

def canonical(value):return json.dumps(json_safe(value),sort_keys=True,separators=(',',':'),allow_nan=False)
def readonly(path):
    path=Path(path).resolve(strict=True)
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    db.execute('PRAGMA query_only=ON');db.execute('BEGIN');return db

def snapshot_receipts(source_path,destination):
    """Consistent public SQLite backup; never copy a live DB file without WAL."""
    destination=Path(destination);require(not destination.exists(),'receipt snapshot output must be new')
    destination.parent.mkdir(parents=True,exist_ok=True);source=readonly(source_path)
    try:
        metadata=dict(source.execute('SELECT k,v FROM meta'))
        require(metadata.get('schema_version')=='2','unsupported receipt schema')
        tables={r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        require({'meta','receipts','ix_outcomes','receipt_addrs'}<=tables and tables<={'meta','receipts','ix_outcomes','receipt_addrs','sqlite_sequence'},'unrelated receipt database')
        target=sqlite3.connect(destination)
        try:source.backup(target)
        finally:target.close()
        return {'metadata':metadata,'snapshot':str(destination),'sources_read_only':True}
    finally:source.close()

@contextmanager
def snapshot(db):
    """Keep all query results on one SQLite snapshot, including WAL writes."""
    own=not db.in_transaction
    if own:db.execute('BEGIN')
    try:yield
    finally:
        if own:db.rollback()

@contextmanager
def atomic(db):
    """Serialize derived-index validation and writes; preserve caller boundaries."""
    own=not db.in_transaction
    db.execute('BEGIN IMMEDIATE' if own else 'SAVEPOINT history_index_write')
    try:
        yield
    except Exception:
        if own:db.rollback()
        else:
            db.execute('ROLLBACK TO history_index_write');db.execute('RELEASE history_index_write')
        raise
    else:
        if own:db.commit()
        else:db.execute('RELEASE history_index_write')

def hash32(value):
    if isinstance(value,list):value=octets(value,32).hex()
    require(type(value) is str and bool(HEX.fullmatch(value)),'invalid hash');return value

def normalize_block(block,wires,source):
    slot=block.get('slot');require(type(slot) is int and 0<slot<2**53,'invalid block slot')
    parent=block.get('previous_hash')
    if parent==[]:parent=''
    if parent!='':parent=hash32(parent)
    require(slot==1 or parent!='','missing parent hash')
    txs=[];raw=[]
    for encoded in wires:
        tx,wire=decode(encoded);txs.append(tx);raw.append(wire)
    require(len(txs)<=4096 and len({t['signature'] for t in txs})==len(txs),'duplicate or oversized transaction list')
    root=hash32(block['merkle_root']);require(merkle(raw)==root,'transaction Merkle mismatch')
    proposer=block.get('proposer');proposer=b58(octets(proposer,32)) if isinstance(proposer,list) else proposer
    result={'slot':slot,'hash':hash32(block['hash']),'previous_hash':parent,'merkle_root':root,
            'proposer':proposer,'transaction_count':len(txs),'poh_timestamp':block.get('poh_timestamp'),
            'sources':[source],'transactions':[t['signature'] for t in txs]}
    if slot==CHECKPOINT_SLOT:require(result['hash']==CHECKPOINT_HASH,'wrong mainnet checkpoint')
    return result,txs

class Index:
    def __init__(self,path):
        self.path=Path(path)
        require(not self.path.is_symlink(),'index symlink rejected');self.path.parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(self.path);self.db.row_factory=sqlite3.Row
        names={r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if names and names!={'metadata','blocks','transactions','addresses','reorgs'}:
            self.db.close();raise ValueError('unrelated index database')
        if names and self.meta('chain_id')!=CHAIN:
            self.db.close();raise ValueError('wrong chain index')
        self.db.execute('PRAGMA foreign_keys=ON');self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS blocks(slot INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,parent TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transactions(signature TEXT PRIMARY KEY,slot INTEGER NOT NULL REFERENCES blocks(slot) ON DELETE CASCADE,position INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tx_order ON transactions(slot DESC,position DESC,signature);
        CREATE TABLE IF NOT EXISTS addresses(address TEXT NOT NULL,signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,PRIMARY KEY(address,signature));
        CREATE TABLE IF NOT EXISTS reorgs(id TEXT PRIMARY KEY,data TEXT NOT NULL);''')
        self.db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)',('chain_id',CHAIN))
        require(self.meta('chain_id')==CHAIN,'wrong chain index');self.db.commit()
    def meta(self,key):
        r=self.db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone();return r[0] if r else None
    def setmeta(self,key,value):self.db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,str(value)))
    def close(self):self.db.close()
    def block(self,identifier):
        if type(identifier) is int or (type(identifier) is str and identifier.isdigit() and len(identifier)<=16):
            slot=int(identifier)
            if not 0<slot<2**53:return None
            r=self.db.execute('SELECT data FROM blocks WHERE slot=?',(slot,)).fetchone()
        else:r=self.db.execute('SELECT data FROM blocks WHERE hash=?',(identifier,)).fetchone()
        return json.loads(r[0]) if r else None
    def transaction(self,signature):
        r=self.db.execute('SELECT data FROM transactions WHERE signature=?',(signature,)).fetchone();return json.loads(r[0]) if r else None
    def _put(self,block,txs):
        require(block['transactions']==[t['signature'] for t in txs],'transaction order mismatch')
        slot=block['slot'];old=self.block(slot)
        if old:
            require(all(old[k]==block[k] for k in ('hash','previous_hash','merkle_root','transactions')),'canonical conflict; explicit suffix replacement required')
            old['sources']=sorted(set(old['sources']+block['sources']))
            if old.get('poh_timestamp') is None:old['poh_timestamp']=block.get('poh_timestamp')
            self.db.execute('UPDATE blocks SET data=? WHERE slot=?',(canonical(old),slot));return False
        previous=self.db.execute('SELECT slot,hash FROM blocks WHERE slot<? ORDER BY slot DESC LIMIT 1',(slot,)).fetchone()
        following=self.db.execute('SELECT slot,parent FROM blocks WHERE slot>? ORDER BY slot LIMIT 1',(slot,)).fetchone()
        if previous:require(block['previous_hash']==previous['hash'],'parent divergence or unindexed gap')
        if following:require(following['parent']==block['hash'],'backfill does not join following block')
        self.db.execute('INSERT INTO blocks VALUES(?,?,?,?)',(slot,block['hash'],block['previous_hash'],canonical(block)))
        for pos,tx in enumerate(txs):
            tx={**tx,'slot':slot,'block_hash':block['hash'],'position':pos,'status':'unknown','receipt':None}
            self.db.execute('INSERT INTO transactions VALUES(?,?,?,?)',(tx['signature'],slot,pos,canonical(tx)))
            self.db.executemany('INSERT INTO addresses VALUES(?,?)',[(a,tx['signature']) for a in tx['addresses']])
        return True
    def put(self,block,txs):
        with atomic(self.db):return self._put(block,txs)
    def receipt(self,signature,value,source):
        with atomic(self.db):return self._receipt(signature,value,source)
    def _receipt(self,signature,value,source):
        tx=self.transaction(signature);require(tx is not None and value.get('slot')==tx['slot'],'receipt identity mismatch')
        outcomes=value.get('meta',{}).get('instructionOutcomes')
        require(type(outcomes) is list and len(outcomes)==len(tx['instructions']) and all(type(r) is dict and type(r.get('index')) is int and r['index']==i and type(r.get('ok')) is bool for i,r in enumerate(outcomes)),'incomplete outcomes')
        ok=[r['ok'] for r in outcomes];status='confirmed' if all(ok) else 'partial' if any(ok) else 'failed'
        failed=next((i for i,v in enumerate(ok) if not v),None)
        expected=None if failed is None else {'InstructionError':[failed,'ExecutionFailed']}
        require('err' in value['meta'] and value['meta']['err']==expected,'receipt error/outcomes mismatch')
        sigs=value.get('transaction',{}).get('signatures');require(sigs==tx['signatures'],'receipt signature mismatch')
        if tx.get('receipt'):
            require(tx['receipt']['evidence']['meta']['instructionOutcomes']==outcomes,'conflicting receipt outcomes')
            if tx['receipt']['source']=='three-node-observer' and source!='three-node-observer':return
        tx.update(status=status,receipt={'source':source,'evidence':json_safe(value)})
        self.db.execute('UPDATE transactions SET data=? WHERE signature=?',(canonical(tx),signature))
        for field in ('from','to'):
            address=value.get('transaction',{}).get(field)
            if type(address) is str and re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}',address):self.db.execute('INSERT OR IGNORE INTO addresses VALUES(?,?)',(address,signature))
    def replace_suffix(self,anchor_slot,anchor_hash,records):
        """Replace only this derived index after a verified common ancestor.

        Caller supplies canonical source evidence; this never alters source data.
        Bad replacement rolls the entire derived mutation back.
        """
        require(records,'empty replacement forbidden')
        with atomic(self.db):
            anchor=self.block(anchor_slot);require(anchor and anchor['hash']==anchor_hash,'unknown common ancestor')
            removed=[dict(r) for r in self.db.execute('SELECT slot,hash FROM blocks WHERE slot>? ORDER BY slot',(anchor_slot,))]
            self.db.execute('DELETE FROM blocks WHERE slot>?',(anchor_slot,))
            last=anchor_slot
            for block,txs in records:
                require(block['slot']>last,'replacement out of order');self._put(block,txs);last=block['slot']
            log={'anchor_slot':anchor_slot,'anchor_hash':anchor_hash,'removed':removed,'new_tip':records[-1][0]['hash']}
            self.db.execute('INSERT INTO reorgs VALUES(?,?)',(hashlib.sha256(canonical(log).encode()).hexdigest(),canonical(log)))
            self.setmeta('revision',int(self.meta('revision') or 0)+1)
            for key in ('observer_bounds','receipt_snapshot','receipt_snapshot_rejected','ledger_prefix'):
                if self.meta(key):self.setmeta('superseded_'+key,self.meta(key))
                self.db.execute('DELETE FROM metadata WHERE key=?',(key,))
    def coverage(self):
        with snapshot(self.db):return self._coverage()
    def _coverage(self):
        rows=self.db.execute('SELECT slot,hash,parent FROM blocks ORDER BY slot').fetchall();gaps=[]
        for a,b in zip(rows,rows[1:]):
            if b['slot']!=a['slot']+1:gaps.append({'from':a['slot']+1,'to':b['slot']-1,'reason':'slots absent from supplied linked canonical records; no independent gap-certificate validation'})
        counts={'blocks':len(rows),'transactions':self.db.execute('SELECT count(*) FROM transactions').fetchone()[0]}
        outcomes={r[0]:r[1] for r in self.db.execute("SELECT json_extract(data,'$.status'),count(*) FROM transactions GROUP BY json_extract(data,'$.status')")}
        observer=self.meta('observer_bounds')
        return {'chain_id':CHAIN,'indexed_from':rows[0]['slot'] if rows else None,'tip':{'slot':rows[-1]['slot'],'hash':rows[-1]['hash']} if rows else None,
            'counts':counts,'gaps':gaps,'genesis_block_present':bool(rows and rows[0]['slot']==1),'execution_outcomes':outcomes,
            'observer_coverage':json.loads(observer) if observer else None,'revision':int(self.meta('revision') or 0),
            'canonical_basis':'Supplied local-node/three-node-observer canonical evidence. Ledger imports recompute every v4 scrypt header commitment and transaction Merkle root, join parent hashes, match the pinned checkpoint and all observer overlap. No independent consensus, difficulty, or cryptographic producer-signature verification.',
            'address_coverage':'Message account keys, supported native/token instruction addresses, and receipt participants. Unparsed embedded address fields are not claimed complete.',
            'raw_wire_coverage':'Every indexed transaction retains complete canonical signed wire bytes and matches its block Merkle root.',
            'receipt_snapshot':json.loads(self.meta('receipt_snapshot')) if self.meta('receipt_snapshot') else None,
            'receipt_snapshot_rejected':json.loads(self.meta('receipt_snapshot_rejected')) if self.meta('receipt_snapshot_rejected') else None,
            'ledger_prefix':json.loads(self.meta('ledger_prefix')) if self.meta('ledger_prefix') else None}
    def page(self,kind='blocks',limit=100,cursor=None,address=None):
        with snapshot(self.db):return self._page(kind,limit,cursor,address)
    def _page(self,kind='blocks',limit=100,cursor=None,address=None,coverage=None):
        require(type(limit) is int and 1<=limit<=100,'page limit must be 1..100')
        coverage=coverage or self.coverage();tip=coverage['tip'];revision=int(self.meta('revision') or 0)
        bound=None
        if cursor:
            require(type(cursor) is str and len(cursor)<=1024,'oversized cursor')
            try:c=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
            except Exception as e:raise ValueError('invalid cursor') from e
            require(type(c) is dict and c.get('kind')==kind and c.get('address')==address and c.get('revision')==revision and type(c.get('tip_slot')) is int,'stale or mismatched cursor')
            tip_block=self.block(c.get('tip_slot'));require(tip_block and tip_block['hash']==c.get('tip_hash'),'cursor anchor no longer canonical')
            bound=c.get('before');tip={'slot':c['tip_slot'],'hash':c['tip_hash']}
        if not tip:return {'data':[],'cursor':None,'coverage':coverage}
        if kind=='blocks':
            require(address is None and (bound is None or type(bound) is int),'invalid block cursor')
            rows=self.db.execute('SELECT data,slot FROM blocks WHERE slot<=? AND (? IS NULL OR slot<?) ORDER BY slot DESC LIMIT ?',(tip['slot'],bound,bound,limit+1)).fetchall()
            more=len(rows)>limit;rows=rows[:limit];data=[json.loads(r['data']) for r in rows];next_bound=rows[-1]['slot'] if rows else None
        else:
            require(kind=='transactions' and (address is None or bool(re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}',address))),'invalid query')
            if bound is not None:require(type(bound) is list and len(bound)==2 and all(type(n) is int for n in bound),'invalid transaction cursor')
            where='t.slot<=?';params=[tip['slot']]
            if bound:where+=' AND (t.slot<? OR (t.slot=? AND t.position<?))';params.extend([bound[0],bound[0],bound[1]])
            if address:where+=' AND EXISTS(SELECT 1 FROM addresses a WHERE a.signature=t.signature AND a.address=?)';params.append(address)
            rows=self.db.execute('SELECT t.* FROM transactions t WHERE '+where+' ORDER BY t.slot DESC,t.position DESC LIMIT ?',params+[limit+1]).fetchall()
            more=len(rows)>limit;rows=rows[:limit];data=[json.loads(r['data']) for r in rows];next_bound=[rows[-1]['slot'],rows[-1]['position']] if rows else None
        next_cursor=base64.urlsafe_b64encode(canonical({'kind':kind,'address':address,'revision':revision,'tip_slot':tip['slot'],'tip_hash':tip['hash'],'before':next_bound}).encode()).decode().rstrip('=') if more else None
        return {'data':data,'cursor':next_cursor,'snapshot_tip':tip,'coverage':coverage}
    def search(self,value):
        with snapshot(self.db):return self._search(value)
    def _search(self,value):
        require(type(value) is str and 1<=len(value)<=128,'invalid search')
        if value.isdigit() or HEX.fullmatch(value):
            block=self.block(value)
            if block:return {'type':'block','data':block}
        tx=self.transaction(value)
        if tx:return {'type':'transaction','data':tx}
        if self.db.execute('SELECT 1 FROM addresses WHERE address=? LIMIT 1',(value,)).fetchone():return {'type':'address','data':self.page('transactions',address=value)}
        return {'type':'not_found','coverage':self.coverage()}

def import_observer(index,path):
    source=readonly(path)
    try:
        binding=json.loads(source.execute("SELECT value FROM observer_metadata WHERE key='binding'").fetchone()[0])
        require(binding=={'schema':1,'chain':CHAIN,'nodes':NODES,'checkpoint_slot':CHECKPOINT_SLOT,'checkpoint_hash':CHECKPOINT_HASH},'observer binding mismatch')
        bounds=source.execute('SELECT min(slot),max(slot),count(*) FROM observer_blocks').fetchone()
        with atomic(index.db):
            for row in source.execute('SELECT * FROM observer_blocks ORDER BY slot'):
                require(hashlib.sha256(row['evidence'].encode()).hexdigest()==row['digest'],'observer digest mismatch')
                e=json.loads(row['evidence']);blocks=e['canonical_blocks_by_node'];receipts=e['receipts_by_node'];require(sorted(blocks)==NODES and sorted(receipts)==NODES,'incomplete observers')
                b=blocks[NODES[0]];require(all(canonical(x)==canonical(b) for x in blocks.values()),'observer block disagreement')
                sigs=[x['signature'] for x in b['transactions']];require(set(sigs)==set(e['raw_transactions_by_signature']),'observer wire coverage mismatch')
                block,txs=normalize_block(b,[e['raw_transactions_by_signature'][s] for s in sigs],'three-node-observer')
                require(block['slot']==row['slot'] and block['hash']==row['hash'] and block['previous_hash']==row['previous_hash'],'observer row identity mismatch')
                index._put(block,txs)
                for sig in sigs:
                    values=[receipts[n][sig] for n in NODES];require(all(canonical(x)==canonical(values[0]) for x in values),'receipt disagreement');index.receipt(sig,values[0],'three-node-observer')
            index.setmeta('observer_bounds',canonical({'from':bounds[0],'to':bounds[1],'blocks':bounds[2]}))
    finally:source.close()

def import_receipts(index,path):
    source=readonly(path)
    try:_import_receipts_snapshot(index,source)
    finally:source.close()

def _import_receipts_snapshot(index,source):
    with atomic(index.db):_import_receipts_locked(index,source)

def _import_receipts_locked(index,source):
    metadata=dict(source.execute('SELECT k,v FROM meta'));slot=int(metadata['tip_slot']);block=index.block(slot)
    require(metadata.get('schema_version')=='2' and block and block['hash']==metadata['tip_hash'],'receipt snapshot tip not in canonical index')
    imported=0;matched_effects=0;unverified_effects=0
    with atomic(index.db):
        for row in index.db.execute('SELECT signature,slot,data FROM transactions WHERE slot<=?',(slot,)).fetchall():
            evidence=source.execute('SELECT * FROM ix_outcomes WHERE signature=? ORDER BY ix_index',(row['signature'],)).fetchall()
            require(all(r['ok'] in (0,1) and r['slot']==row['slot'] for r in evidence),'receipt outcome slot/value mismatch')
            outcomes=[{'index':r['ix_index'],'ok':bool(r['ok'])} for r in evidence]
            if not outcomes:continue
            failed=next((r['index'] for r in outcomes if not r['ok']),None)
            tx=json.loads(row['data'])
            receipts=source.execute('SELECT * FROM receipts WHERE signature=? ORDER BY id',(row['signature'],)).fetchall()
            effects=validate_effects(tx,outcomes,receipts,index.block(row['slot']).get('poh_timestamp'))
            value={'slot':row['slot'],'meta':{'instructionOutcomes':outcomes,'err':None if failed is None else {'InstructionError':[failed,'ExecutionFailed']}},'transaction':{'signatures':tx['signatures']}}
            index.receipt(row['signature'],value,'node-receipt-snapshot');imported+=1
            stored=index.transaction(row['signature']);stored['receipt_effects']={'source':'node-receipt-snapshot','snapshot_tip':{'slot':slot,'hash':metadata['tip_hash']},**effects}
            index.db.execute('UPDATE transactions SET data=? WHERE signature=?',(canonical(stored),row['signature']))
            index.db.executemany('INSERT OR IGNORE INTO addresses VALUES(?,?)',[(a,row['signature']) for a in effects['addresses']])
            matched_effects+=effects['validation']['matched_receipts'];unverified_effects+=effects['validation']['unverified_receipts']
        index.setmeta('receipt_snapshot',canonical({'tip_slot':slot,'tip_hash':metadata['tip_hash'],'outcomes_imported':imported,'wire_matched_receipts':matched_effects,'unverified_receipts':unverified_effects,'unmatched_outcomes_remain_unknown':True}))
        index.db.execute("DELETE FROM metadata WHERE key='receipt_snapshot_rejected'")

def optional_receipts(index,source):
    """Reject incompatible optional outcome evidence without losing valid blocks."""
    try:_import_receipts_snapshot(index,source)
    except (ValueError,sqlite3.DatabaseError) as error:
        metadata=dict(source.execute('SELECT k,v FROM meta'))
        evidence={'reason':str(error),'source_schema':metadata.get('schema_version'),
                  'source_tip_slot':metadata.get('tip_slot'),'source_tip_hash':metadata.get('tip_hash'),
                  'outcomes_imported':0,'unmatched_outcomes_remain_unknown':True}
        with atomic(index.db):index.setmeta('receipt_snapshot_rejected',canonical(evidence))

def backfill_ledger(observer_index,path,output,receipts=None):
    """Stream a fixed file prefix into a new DB, validating against observer overlap.

    New appends are ignored. In-place rewrite/truncation or path replacement aborts.
    Output is never the source or an existing index. Source files are never written.
    """
    path=Path(path).resolve(strict=True);output=Path(output)
    require(not output.exists() and output.resolve()!=path,'backfill requires new output path')
    index=Index(output);matched=0;digest=hashlib.sha256();lines=0;checkpoint=False;receipt_source=None
    source_snapshot=snapshot(observer_index.db);source_snapshot.__enter__()
    try:
        old_tip=observer_index.coverage()['tip']
        if receipts:
            receipt_source=readonly(receipts)
            # BEGIN alone is deferred: this read pins the WAL snapshot before
            # capturing the ledger prefix, so later appends cannot move its tip.
            receipt_source.execute('SELECT k,v FROM meta').fetchall()
        start=path.stat()
        with atomic(index.db), path.open('rb') as stream:
            while stream.tell()<start.st_size:
                raw=stream.readline(4*1024*1024+1);require(raw.endswith(b'\n') and len(raw)<=4*1024*1024,'partial or oversized ledger record')
                require(stream.tell()<=start.st_size,'source append crossed snapshot boundary');digest.update(raw);b=json.loads(raw)
                block,txs=normalize_block(b,[encode(tx) for tx in b['transactions']],'local-ledger')
                require(work_hash(b)==block['hash'],'ledger header commitment mismatch')
                if lines==0:require(block['slot']==1 and block['previous_hash']=='','ledger does not start at genesis block')
                if block['slot']==CHECKPOINT_SLOT:checkpoint=True
                old=observer_index.block(block['slot'])
                if old:
                    require(all(old[k]==block[k] for k in ('hash','previous_hash','merkle_root','transactions')),'ledger conflicts with observer');matched+=1
                index._put(block,txs);lines+=1
            end=os.fstat(stream.fileno());current=path.stat()
            require((start.st_dev,start.st_ino)==(end.st_dev,end.st_ino)==(current.st_dev,current.st_ino) and current.st_size>=start.st_size,'ledger replaced or truncated during snapshot')
            # Rehash the fixed prefix to detect same-inode rewrites as well as
            # atomic replacements. Appending new blocks is allowed.
            stream.seek(0);verify=hashlib.sha256();remaining=start.st_size
            while remaining:
                raw=stream.read(min(1024*1024,remaining));require(raw,'source truncated during verification')
                verify.update(raw);remaining-=len(raw)
            current=path.stat()
            require(verify.digest()==digest.digest() and (current.st_dev,current.st_ino)==(start.st_dev,start.st_ino) and current.st_size>=start.st_size,'source prefix changed during verification')
            require(checkpoint and old_tip and index.block(old_tip['slot'])['hash']==old_tip['hash'],'backfill lacks pinned/observer anchors')
            require(matched==observer_index.coverage()['counts']['blocks'],'observer overlap incomplete')
            index.setmeta('ledger_prefix',canonical({'bytes':start.st_size,'sha256':digest.hexdigest(),'records':lines,'observer_matches':matched,'header_commitments_recomputed':lines,'prefix_rehashed':True}))
        # Merge stronger observer outcomes and provenance without touching source.
        for row in observer_index.db.execute('SELECT data FROM transactions'):
            tx=json.loads(row[0])
            if tx.get('receipt'):
                with atomic(index.db):index.receipt(tx['signature'],tx['receipt']['evidence'],tx['receipt']['source'])
        with atomic(index.db):
            if observer_index.meta('observer_bounds'):index.setmeta('observer_bounds',observer_index.meta('observer_bounds'))
        if receipt_source:optional_receipts(index,receipt_source)
        return index
    except Exception:
        index.close();raise
    finally:
        if receipt_source:receipt_source.close()
        source_snapshot.__exit__(None,None,None)

def export(index,destination):
    destination=Path(destination);require(not destination.exists(),'export destination must be new')
    destination.mkdir(parents=True);files=[]
    def write(path,value):
        body=(canonical(value)+'\n').encode();require(len(body)<=8*1024*1024,'export shard too large')
        p=destination/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body)
        files.append({'path':path,'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body)})
    with snapshot(index.db):
        coverage=index.coverage();coverage.update(block_shard_size=1000,list_page_size=PAGE_SIZE)
        write('coverage.json',coverage);shards={};hashes={}
        for row in index.db.execute('SELECT data FROM blocks ORDER BY slot'):
            b=json.loads(row[0]);shards.setdefault(b['slot']//1000,{})[str(b['slot'])]=b;hashes.setdefault(b['hash'][:2],{})[b['hash']]=b['slot']
        for n,v in shards.items():write(f'blocks/{n}.json',v)
        for prefix,v in hashes.items():write(f'hashes/{prefix}.json',v)
        for row in index.db.execute('SELECT signature,data FROM transactions'):write('transactions/'+row['signature']+'.json',json.loads(row['data']))
        queries=[('blocks',None,'lists/blocks'),('transactions',None,'lists/transactions')]
        queries += [('transactions',row[0],'addresses/'+row[0]) for row in index.db.execute('SELECT DISTINCT address FROM addresses ORDER BY address')]
        for kind,address,prefix in queries:
            cursor=None;n=1
            while True:
                page=index._page(kind,PAGE_SIZE,cursor,address,coverage);write(f'{prefix}/{n}.json',page)
                if not page['cursor']:break
                cursor=page['cursor'];n+=1
        generation=hashlib.sha256(canonical({'chain_id':CHAIN,'coverage':coverage,'files':files}).encode()).hexdigest()
        manifest={'schema_version':1,'chain_id':CHAIN,'generation':generation,'indexed_from':coverage['indexed_from'],'tip':coverage['tip'],'coverage':coverage,'files':files}
        (destination/'manifest.json').write_text(canonical(manifest)+'\n')
    return manifest

def append_ledger(index,path):
    """Append a fixed public ledger prefix after rechecking the retained prefix.

    This does not assume that the observer is online. A changed prefix requires an
    explicit canonical rebuild/reorg workflow; it is never silently overwritten.
    """
    prefix=json.loads(index.meta('ledger_prefix') or 'null')
    require(type(prefix) is dict and prefix.get('prefix_rehashed') is True,'validated ledger prefix required')
    old_bytes=prefix['bytes'];path=Path(path).resolve(strict=True);start=path.stat()
    require(type(old_bytes) is int and 0<old_bytes<=start.st_size,'ledger prefix truncated')
    digest=hashlib.sha256();added=0;matches=0
    with atomic(index.db),path.open('rb') as stream:
        remaining=old_bytes
        while remaining:
            raw=stream.read(min(1024*1024,remaining));require(raw,'ledger prefix truncated')
            digest.update(raw);remaining-=len(raw)
        require(digest.hexdigest()==prefix['sha256'],'retained ledger prefix changed; rebuild required')
        # The prefix digest binds this seam record even when historical slot
        # numbers contain a parent-linked gap.
        stream.seek(max(0,old_bytes-4*1024*1024-2));window=stream.read(old_bytes-stream.tell())
        require(window.endswith(b'\n'),'incomplete old ledger prefix')
        seam=json.loads(window.rsplit(b'\n',2)[-2]);old=index.block(seam['slot'])
        require(old and old['hash']==hash32(seam['hash']),'prefix seam is not canonical')
        stream.seek(old_bytes);last_slot=seam['slot'];last_hash=old['hash']
        while stream.tell()<start.st_size:
            raw=stream.readline(4*1024*1024+1)
            require(raw.endswith(b'\n') and len(raw)<=4*1024*1024 and stream.tell()<=start.st_size,'partial or oversized ledger tail record')
            digest.update(raw);b=json.loads(raw)
            block,txs=normalize_block(b,[encode(tx) for tx in b['transactions']],'local-ledger')
            require(block['slot']>last_slot and block['previous_hash']==last_hash,'ledger tail parent/order mismatch')
            require(work_hash(b)==block['hash'],'ledger tail header commitment mismatch')
            existing=index.block(block['slot'])
            if existing and 'three-node-observer' in existing['sources']:matches+=1
            index._put(block,txs);added+=1;last_slot=block['slot'];last_hash=block['hash']
        stream.seek(0);remaining=start.st_size;verify=hashlib.sha256()
        while remaining:
            raw=stream.read(min(1024*1024,remaining));require(raw,'source truncated during tail verification')
            verify.update(raw);remaining-=len(raw)
        current=path.stat();opened=os.fstat(stream.fileno())
        require((start.st_dev,start.st_ino)==(opened.st_dev,opened.st_ino)==(current.st_dev,current.st_ino) and current.st_size>=start.st_size and verify.digest()==digest.digest(),'source prefix changed during tail verification')
        index.setmeta('ledger_prefix',canonical({'bytes':start.st_size,'sha256':digest.hexdigest(),
            'records':prefix['records']+added,'header_commitments_recomputed':prefix['header_commitments_recomputed']+added,
            'observer_matches':prefix['observer_matches']+matches,'prefix_rehashed':True,
            'last_slot':last_slot,'last_hash':last_hash}))
    return {'records_checked':added,'last_slot':last_slot,'last_hash':last_hash}

def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('observe');p.add_argument('--source',required=True);p.add_argument('--index',required=True)
    p=sub.add_parser('backfill');p.add_argument('--observer-index',required=True);p.add_argument('--ledger',required=True);p.add_argument('--output',required=True);p.add_argument('--receipts')
    p=sub.add_parser('export');p.add_argument('--index',required=True);p.add_argument('--output',required=True)
    p=sub.add_parser('query');p.add_argument('--index',required=True);p.add_argument('value')
    p=sub.add_parser('receipts');p.add_argument('--index',required=True);p.add_argument('--source',required=True)
    p=sub.add_parser('tail');p.add_argument('--index',required=True);p.add_argument('--ledger',required=True)
    p=sub.add_parser('snapshot-receipts');p.add_argument('--source',required=True);p.add_argument('--output',required=True)
    a=parser.parse_args()
    if a.command=='snapshot-receipts':
        print(canonical(snapshot_receipts(a.source,a.output)))
    elif a.command=='observe':
        index=Index(a.index);import_observer(index,a.source);print(canonical(index.coverage()));index.close()
    elif a.command=='backfill':
        old=Index(a.observer_index)
        try:index=backfill_ledger(old,a.ledger,a.output,a.receipts);print(canonical(index.coverage()));index.close()
        finally:old.close()
    elif a.command=='receipts':
        index=Index(a.index)
        try:import_receipts(index,a.source);print(canonical(index.coverage()))
        finally:index.close()
    elif a.command=='tail':
        index=Index(a.index)
        try:result=append_ledger(index,a.ledger);print(canonical({'tail':result,'coverage':index.coverage()}))
        finally:index.close()
    else:
        index=Index(a.index)
        try:print(canonical(export(index,a.output) if a.command=='export' else index.search(a.value)))
        finally:index.close()
if __name__=='__main__':main()
