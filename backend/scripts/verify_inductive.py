"""Verify the Rust Inductive Miner matches pm4py's IM (process-tree language
equivalence) on every available flat event log, and benchmark both.

The Rust tree is converted to a pm4py ProcessTree and compared with pm4py's
own `structurally_language_equal` (which is commutative-operator aware), after
`fold`. Trees are the canonical IM output, so equality here means the discovered
Petri nets are language-equivalent too.
"""
from __future__ import annotations
import gzip, sys, time, io
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
EX = ROOT.parent / "docs" / "examples"
CASE, ACT, TS = "case:concept:name", "concept:name", "time:timestamp"

import flowminer_accel as fa
import pm4py
from pm4py.objects.process_tree.obj import ProcessTree, Operator
from pm4py.objects.process_tree.utils.generic import fold, tree_sort, structurally_language_equal

OPS = {"->": Operator.SEQUENCE, "X": Operator.XOR, "+": Operator.PARALLEL, "*": Operator.LOOP}

# (file, case_col, activity_col, timestamp_col, gzipped)
LOGS = [
    ("running-example.csv", "case:concept:name", "concept:name", "time:timestamp", False),
    ("HR_Onboarding.1.csv", "Employee_ID", "Activity", "Timestamp", False),
    ("HR_Onboarding.2.csv", "Employee_ID", "Activity", "Timestamp", False),
    ("tpch_order_to_cash.csv", "case_id", "activity", "timestamp", False),
    ("sepsis.csv", "case_id", "activity", "timestamp", False),
    ("bpic2019_p2p.csv.gz", "case_id", "activity", "timestamp", True),
]


def load(fname, ccol, acol, tcol, gz):
    path = EX / fname
    if gz:
        with gzip.open(path, "rt") as f:
            df = pd.read_csv(f)
    else:
        df = pd.read_csv(path)
    df = df.rename(columns={ccol: CASE, acol: ACT, tcol: TS})
    df = df[[CASE, ACT, TS]].copy()
    df[CASE] = df[CASE].astype(str)
    df[ACT] = df[ACT].astype(str)
    df[TS] = pd.to_datetime(df[TS], utc=True, errors="coerce")
    df = df.dropna(subset=[TS])
    # stable order so tie-breaking matches between the two paths
    df = df.sort_values([CASE, TS], kind="mergesort").reset_index(drop=True)
    return df


def encode(df):
    cc = df[CASE].astype("category")
    ac = df[ACT].astype("category")
    ts = df[TS].astype(np.int64).values
    dt = str(df[TS].dtype)
    if "us" in dt:
        ts = ts * 1_000
    elif "ms" in dt:
        ts = ts * 1_000_000
    return (cc.cat.codes.values.astype(np.int32),
            ac.cat.codes.values.astype(np.int32),
            ac.cat.categories.tolist(), ts)


def build_pt(node):
    if node is None:
        return ProcessTree()  # tau
    if isinstance(node, str):
        return ProcessTree(label=node)
    sym, children = node
    t = ProcessTree(operator=OPS[sym])
    for c in children:
        ch = build_pt(c)
        ch.parent = t
        t.children.append(ch)
    return t


def tree_size(t):
    return 1 + sum(tree_size(c) for c in t.children)


def main():
    print(f"{'log':<26}{'events':>9}{'cases':>8}{'acts':>6}  "
          f"{'rust':>8}{'pm4py':>9}{'speedup':>8}  equal")
    print("-" * 82)
    n_pass = 0
    for fname, ccol, acol, tcol, gz in LOGS:
        df = load(fname, ccol, acol, tcol, gz)
        cc, ac, labels, ts = encode(df)

        t0 = time.perf_counter()
        rust_raw = fa.discover_inductive_tree(cc, ac, labels, ts)
        rust_dt = time.perf_counter() - t0
        my_tree = fold(build_pt(rust_raw))

        t0 = time.perf_counter()
        pm_tree = pm4py.discover_process_tree_inductive(
            df, activity_key=ACT, case_id_key=CASE, timestamp_key=TS)
        pm_dt = time.perf_counter() - t0

        # canonicalize both (sort commutative children) then compare two ways:
        #  - structural LANGUAGE equality (pm4py's own, commutative-aware)
        #  - exact canonical-string equality (stricter)
        tree_sort(my_tree)
        tree_sort(pm_tree)
        lang_eq = structurally_language_equal(my_tree, pm_tree)
        str_eq = my_tree.__repr__() == pm_tree.__repr__()
        equal = lang_eq
        n_pass += equal
        speed = pm_dt / rust_dt if rust_dt > 0 else float("inf")
        sz = tree_size(pm_tree)
        if equal:
            mark = f"PASS ({sz} nodes, exact_str={'Y' if str_eq else 'n'})"
        else:
            mark = f"FAIL ({tree_size(my_tree)} vs {sz} nodes)"
        print(f"{fname:<26}{len(df):>9,}{df[CASE].nunique():>8,}{df[ACT].nunique():>6}  "
              f"{rust_dt:>7.3f}s{pm_dt:>8.3f}s{speed:>7.0f}x  {mark}")

    print("-" * 82)
    print(f"{n_pass}/{len(LOGS)} logs: Rust IM tree == pm4py IM tree")
    return 0 if n_pass == len(LOGS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
