//! Inductive Miner (IM variant, log-based) — a faithful Rust port of pm4py
//! 2.7.22.4's `discover_process_tree_inductive` (default IM / UVCL path).
//!
//! Operates on the UVCL (a multiset of trace variants) exactly like pm4py.
//! Cut *detection* is purely structural (edge / start / end membership — edge
//! frequencies are irrelevant for IM, only IMf filters on them); projections
//! preserve variant frequencies. Returns a process tree which the Python side
//! turns into a pm4py ProcessTree for `structurally_language_equal` comparison.
//!
//! NOT wired into the discovery service — this is a standalone, verified port.

use numpy::PyReadonlyArray1;
use pyo3::prelude::*;
use pyo3::types::{PyList, PyString, PyTuple};
use rustc_hash::{FxHashMap, FxHashSet};

type Variant = Vec<u32>;
type Uvcl = FxHashMap<Variant, u64>;

#[derive(Clone, Copy)]
enum Op {
    Seq,
    Xor,
    Par,
    Loop,
}

enum Tree {
    Leaf(Option<u32>), // Some(activity id) or None (tau)
    Node(Op, Vec<Tree>),
}

struct Dfg {
    edges: FxHashSet<(u32, u32)>,
    start: FxHashSet<u32>,
    end: FxHashSet<u32>,
    vertices: Vec<u32>, // sorted, unique
}

fn build_dfg(uvcl: &Uvcl) -> Dfg {
    let mut edges = FxHashSet::default();
    let mut start = FxHashSet::default();
    let mut end = FxHashSet::default();
    let mut vset = FxHashSet::default();
    for t in uvcl.keys() {
        if t.is_empty() {
            continue;
        }
        start.insert(t[0]);
        end.insert(*t.last().unwrap());
        for w in t.windows(2) {
            edges.insert((w[0], w[1]));
        }
        for &a in t {
            vset.insert(a);
        }
    }
    let mut vertices: Vec<u32> = vset.into_iter().collect();
    vertices.sort_unstable();
    Dfg { edges, start, end, vertices }
}

// ── union-find over a vertex list ────────────────────────────────────

struct UnionFind {
    parent: FxHashMap<u32, u32>,
}
impl UnionFind {
    fn new(verts: &[u32]) -> Self {
        UnionFind { parent: verts.iter().map(|&v| (v, v)).collect() }
    }
    fn find(&mut self, x: u32) -> u32 {
        let mut root = x;
        while self.parent[&root] != root {
            root = self.parent[&root];
        }
        let mut cur = x;
        while cur != root {
            let next = self.parent[&cur];
            self.parent.insert(cur, root);
            cur = next;
        }
        root
    }
    fn union(&mut self, a: u32, b: u32) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent.insert(ra, rb);
        }
    }
}

/// Connected components of the graph over `verts` where an edge exists iff
/// `merge(a, b)` is true. Each component is a sorted set; components are
/// ordered by their minimum element (deterministic).
fn components<F: Fn(u32, u32) -> bool>(verts: &[u32], merge: F) -> Vec<FxHashSet<u32>> {
    let mut uf = UnionFind::new(verts);
    for i in 0..verts.len() {
        for j in (i + 1)..verts.len() {
            if merge(verts[i], verts[j]) {
                uf.union(verts[i], verts[j]);
            }
        }
    }
    let mut by_root: FxHashMap<u32, FxHashSet<u32>> = FxHashMap::default();
    for &v in verts {
        let r = uf.find(v);
        by_root.entry(r).or_default().insert(v);
    }
    let mut groups: Vec<FxHashSet<u32>> = by_root.into_values().collect();
    groups.sort_by_key(|g| *g.iter().min().unwrap());
    groups
}

// ── transitive reachability (nx ancestors/descendants, excluding self) ─

fn transitive(dfg: &Dfg) -> (FxHashMap<u32, FxHashSet<u32>>, FxHashMap<u32, FxHashSet<u32>>) {
    let mut succ: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut pred: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for &v in &dfg.vertices {
        succ.entry(v).or_default();
        pred.entry(v).or_default();
    }
    for &(a, b) in &dfg.edges {
        succ.get_mut(&a).unwrap().push(b);
        pred.get_mut(&b).unwrap().push(a);
    }
    let reach = |adj: &FxHashMap<u32, Vec<u32>>, src: u32| -> FxHashSet<u32> {
        let mut seen = FxHashSet::default();
        let mut stack = adj[&src].clone();
        while let Some(x) = stack.pop() {
            if seen.insert(x) {
                for &n in &adj[&x] {
                    if !seen.contains(&n) {
                        stack.push(n);
                    }
                }
            }
        }
        seen.remove(&src); // nx excludes the source node itself
        seen
    };
    let mut post = FxHashMap::default();
    let mut pre = FxHashMap::default();
    for &v in &dfg.vertices {
        post.insert(v, reach(&succ, v));
        pre.insert(v, reach(&pred, v));
    }
    (pre, post)
}

// ── XOR cut ──────────────────────────────────────────────────────────

fn xor_cut(dfg: &Dfg) -> Option<Vec<FxHashSet<u32>>> {
    let mut undirected: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for &v in &dfg.vertices {
        undirected.entry(v).or_default();
    }
    for &(a, b) in &dfg.edges {
        undirected.get_mut(&a).unwrap().push(b);
        undirected.get_mut(&b).unwrap().push(a);
    }
    let groups = components(&dfg.vertices, |a, b| {
        // adjacency check is cheap enough via the edge set both directions
        dfg.edges.contains(&(a, b)) || dfg.edges.contains(&(b, a))
    });
    let _ = undirected;
    if groups.len() > 1 {
        Some(groups)
    } else {
        None
    }
}

fn xor_project(uvcl: &Uvcl, groups: &[FxHashSet<u32>]) -> Vec<Uvcl> {
    let mut logs: Vec<Uvcl> = vec![FxHashMap::default(); groups.len()];
    for (t, &c) in uvcl {
        // group with the most of t's activities (count desc, index asc on ties)
        let mut best = 0usize;
        let mut best_cnt: i64 = -1;
        for (gi, g) in groups.iter().enumerate() {
            let cnt = t.iter().filter(|e| g.contains(e)).count() as i64;
            if cnt > best_cnt {
                best_cnt = cnt;
                best = gi;
            }
        }
        let g = &groups[best];
        let nt: Variant = t.iter().cloned().filter(|e| g.contains(e)).collect();
        *logs[best].entry(nt).or_insert(0) += c;
    }
    logs
}

// ── Sequence cut (strict) ────────────────────────────────────────────

fn sequence_base_groups(dfg: &Dfg) -> Option<Vec<FxHashSet<u32>>> {
    if dfg.vertices.is_empty() {
        return None;
    }
    let (pre, post) = transitive(dfg);
    // merge a,b iff mutually reachable OR mutually unreachable
    let groups = components(&dfg.vertices, |a, b| {
        let ab = post[&a].contains(&b);
        let ba = post[&b].contains(&a);
        (ab && ba) || (!ab && !ba)
    });
    // sort by reachability key = |pre[rep]| + |V| - |post[rep]|, rep = min id
    let n = dfg.vertices.len();
    let mut order: Vec<FxHashSet<u32>> = groups;
    order.sort_by_key(|g| {
        let rep = *g.iter().min().unwrap();
        let key = pre[&rep].len() as i64 + (n as i64 - post[&rep].len() as i64);
        (key, rep)
    });
    if order.len() > 1 {
        Some(order)
    } else {
        None
    }
}

fn strict_sequence_cut(dfg: &Dfg) -> Option<Vec<FxHashSet<u32>>> {
    let c0 = sequence_base_groups(dfg)?;
    let mut c: Vec<FxHashSet<u32>> = c0;
    let n = c.len();
    let big = i64::MAX / 4;
    let mut mf: Vec<i64> = (0..n)
        .map(|i| if c[i].iter().any(|a| dfg.start.contains(a)) { -big } else { big })
        .collect();
    let mut mt: Vec<i64> = (0..n)
        .map(|i| if c[i].iter().any(|a| dfg.end.contains(a)) { big } else { -big })
        .collect();
    // cmap: activity -> group index
    let mut cmap: FxHashMap<u32, usize> = FxHashMap::default();
    for (i, g) in c.iter().enumerate() {
        for &a in g {
            cmap.insert(a, i);
        }
    }
    for &(a, b) in &dfg.edges {
        let cb = cmap[&b];
        let ca = cmap[&a] as i64;
        if ca < mf[cb] {
            mf[cb] = ca;
        }
        let cb2 = cmap[&b] as i64;
        let ca2 = cmap[&a];
        if cb2 > mt[ca2] {
            mt[ca2] = cb2;
        }
    }

    let skippable = |p: usize, c: &Vec<FxHashSet<u32>>| -> bool {
        for i in 0..p {
            for j in (p + 1)..c.len() {
                for &a in &c[i] {
                    for &b in &c[j] {
                        if dfg.edges.contains(&(a, b)) {
                            return true;
                        }
                    }
                }
            }
        }
        for j in (p + 1)..c.len() {
            if c[j].iter().any(|a| dfg.start.contains(a)) {
                return true;
            }
        }
        for i in 0..p {
            if c[i].iter().any(|a| dfg.end.contains(a)) {
                return true;
            }
        }
        false
    };

    for p in 0..n {
        if skippable(p, &c) {
            let mut q: i64 = p as i64 - 1;
            while q >= 0 && mt[q as usize] <= p as i64 {
                let taken = std::mem::take(&mut c[q as usize]);
                c[p].extend(taken);
                q -= 1;
            }
            let mut q2: usize = p + 1;
            while q2 < n && mf[q2] >= p as i64 {
                let taken = std::mem::take(&mut c[q2]);
                c[p].extend(taken);
                q2 += 1;
            }
        }
    }
    let out: Vec<FxHashSet<u32>> = c.into_iter().filter(|g| !g.is_empty()).collect();
    if out.len() > 1 {
        Some(out)
    } else {
        None
    }
}

fn find_split_point(t: &[u32], group: &FxHashSet<u32>, start: usize, ignore: &FxHashSet<u32>) -> usize {
    let mut least_cost = 0i64;
    let mut pos = start;
    let mut cost = 0i64;
    let mut i = start;
    while i < t.len() {
        if group.contains(&t[i]) {
            cost -= 1;
        } else if !ignore.contains(&t[i]) {
            cost += 1;
        }
        if cost < least_cost {
            least_cost = cost;
            pos = i + 1;
        }
        i += 1;
    }
    pos
}

fn sequence_project(uvcl: &Uvcl, groups: &[FxHashSet<u32>]) -> Vec<Uvcl> {
    let mut logs: Vec<Uvcl> = vec![FxHashMap::default(); groups.len()];
    for (t, &c) in uvcl {
        let mut split_point = 0usize;
        let mut ignore: FxHashSet<u32> = FxHashSet::default();
        for (i, g) in groups.iter().enumerate() {
            let new_split = find_split_point(t, g, split_point, &ignore);
            let mut trace_i: Variant = Vec::new();
            for j in split_point..new_split {
                if g.contains(&t[j]) {
                    trace_i.push(t[j]);
                }
            }
            *logs[i].entry(trace_i).or_insert(0) += c;
            split_point = new_split;
            for &a in g {
                ignore.insert(a);
            }
        }
    }
    logs
}

// ── Concurrency (parallel) cut ───────────────────────────────────────

fn concurrency_cut(dfg: &Dfg) -> Option<Vec<FxHashSet<u32>>> {
    if dfg.vertices.is_empty() {
        return None;
    }
    // merge a,b iff NOT bidirectionally connected
    let mut groups = components(&dfg.vertices, |a, b| {
        !(dfg.edges.contains(&(a, b)) && dfg.edges.contains(&(b, a)))
    });
    // sort by size ascending (ties keep min-id order from `components`)
    groups.sort_by_key(|g| g.len());
    // merge groups lacking BOTH a start and an end activity into a neighbour
    let mut i = 0usize;
    while i < groups.len() && groups.len() > 1 {
        let has_start = groups[i].iter().any(|a| dfg.start.contains(a));
        let has_end = groups[i].iter().any(|a| dfg.end.contains(a));
        if has_start && has_end {
            i += 1;
            continue;
        }
        let group = std::mem::take(&mut groups[i]);
        groups.remove(i);
        if i == 0 {
            let g0: Vec<u32> = group.into_iter().collect();
            groups[0].extend(g0);
        } else {
            let gi: Vec<u32> = group.into_iter().collect();
            groups[i - 1].extend(gi);
        }
    }
    if groups.len() > 1 {
        Some(groups)
    } else {
        None
    }
}

fn concurrency_project(uvcl: &Uvcl, groups: &[FxHashSet<u32>]) -> Vec<Uvcl> {
    let mut logs: Vec<Uvcl> = vec![FxHashMap::default(); groups.len()];
    for (t, &c) in uvcl {
        for (i, g) in groups.iter().enumerate() {
            let nt: Variant = t.iter().cloned().filter(|e| g.contains(e)).collect();
            *logs[i].entry(nt).or_insert(0) += c;
        }
    }
    logs
}

// ── Loop cut (this pm4py build: exactly [do, merged-redo]) ───────────

fn find_group(groups: &[FxHashSet<u32>], a: u32) -> Option<usize> {
    groups.iter().position(|g| g.contains(&a))
}

fn merge_to_front(groups: &mut Vec<FxHashSet<u32>>, ia: usize, ib: usize) {
    let mut union = FxHashSet::default();
    for &x in &groups[ia] {
        union.insert(x);
    }
    for &x in &groups[ib] {
        union.insert(x);
    }
    let mut new_groups: Vec<FxHashSet<u32>> = vec![union];
    for (k, g) in groups.drain(..).enumerate() {
        if k != ia && k != ib {
            new_groups.push(g);
        }
    }
    *groups = new_groups;
}

fn loop_cut(dfg: &Dfg) -> Option<Vec<FxHashSet<u32>>> {
    if dfg.edges.is_empty() {
        return None;
    }
    let boundary: FxHashSet<u32> = dfg.start.union(&dfg.end).cloned().collect();
    let mut groups: Vec<FxHashSet<u32>> = vec![boundary.clone()];

    // connected components after removing boundary nodes and their edges
    let inner_verts: Vec<u32> = dfg.vertices.iter().cloned().filter(|v| !boundary.contains(v)).collect();
    let inner_edges: FxHashSet<(u32, u32)> = dfg
        .edges
        .iter()
        .cloned()
        .filter(|(a, b)| !boundary.contains(a) && !boundary.contains(b))
        .collect();
    let cc = components(&inner_verts, |a, b| {
        inner_edges.contains(&(a, b)) || inner_edges.contains(&(b, a))
    });
    for c in cc {
        groups.push(c);
    }

    let start = &dfg.start;
    let end = &dfg.end;

    // _exclude_sets_non_reachable_from_start
    let mut sd: Vec<u32> = start.difference(end).cloned().collect();
    sd.sort_unstable();
    let mut edges_sorted: Vec<(u32, u32)> = dfg.edges.iter().cloned().collect();
    edges_sorted.sort_unstable();
    for a in sd {
        for &(x, b) in &edges_sorted {
            if x == a {
                if let (Some(ia), Some(ib)) = (find_group(&groups, a), find_group(&groups, b)) {
                    merge_to_front(&mut groups, ia, ib);
                }
            }
        }
    }
    // _exclude_sets_no_reachable_from_end
    let mut ed: Vec<u32> = end.difference(start).cloned().collect();
    ed.sort_unstable();
    for b in ed {
        for &(a, x) in &edges_sorted {
            if x == b {
                if let (Some(ia), Some(ib)) = (find_group(&groups, a), find_group(&groups, b)) {
                    merge_to_front(&mut groups, ia, ib);
                }
            }
        }
    }
    // _check_start_completeness
    let mut i = 1usize;
    while i < groups.len() {
        let mut merge = false;
        'outer: for &a in &groups[i] {
            for &(x, b) in &dfg.edges {
                if x == a && start.contains(&b) {
                    for &s in start {
                        if !dfg.edges.contains(&(a, s)) {
                            merge = true;
                            break 'outer;
                        }
                    }
                }
            }
        }
        if merge {
            let g = std::mem::take(&mut groups[i]);
            for x in g {
                groups[0].insert(x);
            }
            groups.remove(i);
            continue;
        }
        i += 1;
    }
    // _check_end_completeness
    let mut i = 1usize;
    while i < groups.len() {
        let mut merge = false;
        'outer2: for &a in &groups[i] {
            for &(b, x) in &dfg.edges {
                if x == a && end.contains(&b) {
                    for &e in end {
                        if !dfg.edges.contains(&(e, a)) {
                            merge = true;
                            break 'outer2;
                        }
                    }
                }
            }
        }
        if merge {
            let g = std::mem::take(&mut groups[i]);
            for x in g {
                groups[0].insert(x);
            }
            groups.remove(i);
            continue;
        }
        i += 1;
    }

    let nonempty: Vec<FxHashSet<u32>> = groups.into_iter().filter(|g| !g.is_empty()).collect();
    if nonempty.len() <= 1 {
        return None;
    }
    let mut redo = FxHashSet::default();
    for g in &nonempty[1..] {
        for &x in g {
            redo.insert(x);
        }
    }
    Some(vec![nonempty[0].clone(), redo])
}

fn loop_project(uvcl: &Uvcl, groups: &[FxHashSet<u32>]) -> Vec<Uvcl> {
    let do_set = &groups[0];
    let redo_set = &groups[1]; // single merged redo group
    let mut do_log: Uvcl = FxHashMap::default();
    let mut redo_log: Uvcl = FxHashMap::default();
    for (t, &card) in uvcl {
        let mut do_trace: Variant = Vec::new();
        let mut redo_trace: Variant = Vec::new();
        for &e in t {
            if do_set.contains(&e) {
                do_trace.push(e);
                if !redo_trace.is_empty() {
                    *redo_log.entry(std::mem::take(&mut redo_trace)).or_insert(0) += card;
                }
            } else if redo_set.contains(&e) {
                redo_trace.push(e);
                if !do_trace.is_empty() {
                    *do_log.entry(std::mem::take(&mut do_trace)).or_insert(0) += card;
                }
            } else {
                if !do_trace.is_empty() {
                    *do_log.entry(std::mem::take(&mut do_trace)).or_insert(0) += card;
                }
                if !redo_trace.is_empty() {
                    *redo_log.entry(std::mem::take(&mut redo_trace)).or_insert(0) += card;
                }
            }
        }
        if !redo_trace.is_empty() {
            *redo_log.entry(redo_trace).or_insert(0) += card;
        }
        *do_log.entry(do_trace).or_insert(0) += card; // keep empty do slices
    }
    vec![do_log, redo_log]
}

// ── fall-throughs ────────────────────────────────────────────────────

fn alphabet_sorted(uvcl: &Uvcl) -> Vec<u32> {
    let mut s: FxHashSet<u32> = FxHashSet::default();
    for t in uvcl.keys() {
        for &a in t {
            s.insert(a);
        }
    }
    let mut v: Vec<u32> = s.into_iter().collect();
    v.sort_unstable();
    v
}

fn activity_once_per_trace_candidate(uvcl: &Uvcl) -> Option<u32> {
    let mut candidates: FxHashSet<u32> = alphabet_sorted(uvcl).into_iter().collect();
    for t in uvcl.keys() {
        let mut counts: FxHashMap<u32, u32> = FxHashMap::default();
        for &a in t {
            *counts.entry(a).or_insert(0) += 1;
        }
        let once: FxHashSet<u32> = counts.iter().filter(|(_, &c)| c == 1).map(|(&a, _)| a).collect();
        candidates = candidates.intersection(&once).cloned().collect();
        if candidates.is_empty() {
            return None;
        }
    }
    candidates.into_iter().min()
}

fn split_on_candidate(uvcl: &Uvcl, cand: u32) -> (Uvcl, Uvcl) {
    let mut l_a: Uvcl = FxHashMap::default();
    let mut l_other: Uvcl = FxHashMap::default();
    for (t, &c) in uvcl {
        let a: Variant = t.iter().cloned().filter(|&e| e == cand).collect();
        let o: Variant = t.iter().cloned().filter(|&e| e != cand).collect();
        *l_a.entry(a).or_insert(0) += c;
        *l_other.entry(o).or_insert(0) += c;
    }
    (l_a, l_other)
}

fn any_cut_holds(uvcl: &Uvcl) -> bool {
    let dfg = build_dfg(uvcl);
    xor_cut(&dfg).is_some()
        || strict_sequence_cut(&dfg).is_some()
        || concurrency_cut(&dfg).is_some()
        || loop_cut(&dfg).is_some()
}

fn activity_concurrent_candidate(uvcl: &Uvcl) -> Option<u32> {
    for a in alphabet_sorted(uvcl) {
        let mut l_alt: Uvcl = FxHashMap::default();
        for (t, &c) in uvcl {
            let nt: Variant = t.iter().cloned().filter(|&e| e != a).collect();
            *l_alt.entry(nt).or_insert(0) += c;
        }
        if any_cut_holds(&l_alt) {
            return Some(a);
        }
    }
    None
}

/// projected log when splitting at end->start (strict) or any-start boundaries.
fn tau_loop_project(uvcl: &Uvcl, strict: bool) -> Uvcl {
    let dfg = build_dfg(uvcl);
    let start = &dfg.start;
    let end = &dfg.end;
    let mut proj: Uvcl = FxHashMap::default();
    for (t, &c) in uvcl {
        let mut x = 0usize;
        for i in 1..t.len() {
            let split = if strict {
                start.contains(&t[i]) && end.contains(&t[i - 1])
            } else {
                start.contains(&t[i])
            };
            if split {
                *proj.entry(t[x..i].to_vec()).or_insert(0) += c;
                x = i;
            }
        }
        *proj.entry(t[x..].to_vec()).or_insert(0) += c;
    }
    proj
}

fn total(uvcl: &Uvcl) -> u64 {
    uvcl.values().sum()
}

// ── the recursion ────────────────────────────────────────────────────

fn apply(uvcl: &Uvcl) -> Tree {
    // 1. empty-trace handling (IMUVCL.apply special case)
    let empty: Variant = Vec::new();
    if uvcl.contains_key(&empty) {
        let mut rest = uvcl.clone();
        rest.remove(&empty);
        if !rest.is_empty() {
            return Tree::Node(Op::Xor, vec![Tree::Leaf(None), apply(&rest)]);
        }
        return Tree::Leaf(None);
    }
    // 2. base cases
    if uvcl.is_empty() {
        return Tree::Leaf(None);
    }
    if uvcl.len() == 1 {
        let t = uvcl.keys().next().unwrap();
        if t.len() <= 1 {
            return if t.is_empty() { Tree::Leaf(None) } else { Tree::Leaf(Some(t[0])) };
        }
    }
    // 3. cuts (XOR, StrictSequence, Concurrency, Loop)
    let dfg = build_dfg(uvcl);
    if let Some(groups) = xor_cut(&dfg) {
        return Tree::Node(Op::Xor, xor_project(uvcl, &groups).iter().map(apply).collect());
    }
    if let Some(groups) = strict_sequence_cut(&dfg) {
        return Tree::Node(Op::Seq, sequence_project(uvcl, &groups).iter().map(apply).collect());
    }
    if let Some(groups) = concurrency_cut(&dfg) {
        return Tree::Node(Op::Par, concurrency_project(uvcl, &groups).iter().map(apply).collect());
    }
    if let Some(groups) = loop_cut(&dfg) {
        return Tree::Node(Op::Loop, loop_project(uvcl, &groups).iter().map(apply).collect());
    }
    // 4. fall-throughs (EmptyTraces already handled above)
    if let Some(cand) = activity_once_per_trace_candidate(uvcl) {
        let (l_a, l_other) = split_on_candidate(uvcl, cand);
        return Tree::Node(Op::Par, vec![apply(&l_a), apply(&l_other)]);
    }
    if let Some(cand) = activity_concurrent_candidate(uvcl) {
        let (l_a, l_other) = split_on_candidate(uvcl, cand);
        return Tree::Node(Op::Par, vec![apply(&l_a), apply(&l_other)]);
    }
    let strict_proj = tau_loop_project(uvcl, true);
    if total(&strict_proj) > total(uvcl) {
        return Tree::Node(Op::Loop, vec![apply(&strict_proj), Tree::Leaf(None)]);
    }
    let loose_proj = tau_loop_project(uvcl, false);
    if total(&loose_proj) > total(uvcl) {
        return Tree::Node(Op::Loop, vec![apply(&loose_proj), Tree::Leaf(None)]);
    }
    // flower model
    let mut redo: Uvcl = FxHashMap::default();
    for a in alphabet_sorted(uvcl) {
        redo.insert(vec![a], 1);
    }
    Tree::Node(Op::Loop, vec![Tree::Leaf(None), apply(&redo)])
}

// ── Python interface ─────────────────────────────────────────────────

fn build_uvcl(cases: &[i32], acts: &[i32], ts: &[i64]) -> Uvcl {
    let n = cases.len();
    let mut order: Vec<u32> = (0..n as u32).collect();
    order.sort_unstable_by(|&a, &b| {
        let (a, b) = (a as usize, b as usize);
        cases[a].cmp(&cases[b]).then_with(|| ts[a].cmp(&ts[b])).then_with(|| a.cmp(&b))
    });
    let mut uvcl: Uvcl = FxHashMap::default();
    let mut cur: Variant = Vec::new();
    let mut prev_case: i32 = if n > 0 { cases[order[0] as usize] } else { 0 };
    for &idx in &order {
        let idx = idx as usize;
        if cases[idx] != prev_case {
            *uvcl.entry(std::mem::take(&mut cur)).or_insert(0) += 1;
            prev_case = cases[idx];
        }
        cur.push(acts[idx] as u32);
    }
    if n > 0 {
        *uvcl.entry(cur).or_insert(0) += 1;
    }
    uvcl
}

fn tree_to_py<'py>(py: Python<'py>, tree: &Tree, labels: &[String]) -> PyResult<Bound<'py, PyAny>> {
    match tree {
        Tree::Leaf(None) => Ok(py.None().into_bound(py)),
        Tree::Leaf(Some(a)) => Ok(PyString::new(py, &labels[*a as usize]).into_any()),
        Tree::Node(op, children) => {
            let sym = match op {
                Op::Seq => "->",
                Op::Xor => "X",
                Op::Par => "+",
                Op::Loop => "*",
            };
            let ch = PyList::empty(py);
            for c in children {
                ch.append(tree_to_py(py, c, labels)?)?;
            }
            let tup = PyTuple::new(py, &[PyString::new(py, sym).into_any(), ch.into_any()])?;
            Ok(tup.into_any())
        }
    }
}

/// Discover an Inductive-Miner process tree (pm4py IM/UVCL semantics).
///
/// Returns the tree as nested Python objects: an activity leaf is its label
/// (str), a tau leaf is None, an operator node is a tuple (symbol, [children])
/// with symbol in {"->", "X", "+", "*"}.
#[pyfunction]
pub fn discover_inductive_tree<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyAny>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let uvcl = build_uvcl(cases, acts, ts);
    let tree = py.allow_threads(|| apply(&uvcl));
    tree_to_py(py, &tree, &act_labels)
}
