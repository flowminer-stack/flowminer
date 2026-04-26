//! FlowMiner Rust acceleration layer.
//!
//! High-performance replacements for hot-path process mining algorithms.
//! All functions accept categorically-encoded numpy arrays to minimize
//! Python↔Rust marshalling overhead.
//!
//! Timestamps are always passed as int64 nanoseconds since epoch.
//! The Python wrapper (`app.services.rust_accel`) handles the conversion
//! from pandas datetime columns.

use numpy::PyReadonlyArray1;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyTuple};
use rustc_hash::FxHashMap;

// ── helpers ──────────────────────────────────────────────────────────

/// Build a (case, timestamp, row-index) stable sort order.
fn build_order(cases: &[i32], ts: &[i64]) -> Vec<u32> {
    let n = cases.len();
    let mut order: Vec<u32> = (0..n as u32).collect();
    order.sort_unstable_by(|&a, &b| {
        let a = a as usize;
        let b = b as usize;
        cases[a]
            .cmp(&cases[b])
            .then_with(|| ts[a].cmp(&ts[b]))
            .then_with(|| a.cmp(&b))
    });
    order
}

fn median_sorted(v: &mut Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

// ── DFG discovery ───────────────────────────────────────────────────

/// Discover a Directly-Follows Graph from categorically-encoded arrays.
/// Returns (dfg_dict, start_activities, end_activities).
#[pyfunction]
fn discover_dfg<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyTuple>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let mut dfg_counts = vec![0u64; n_acts * n_acts];
    let mut start_counts = vec![0u64; n_acts];
    let mut end_counts = vec![0u64; n_acts];

    if n == 0 {
        let d = PyDict::new(py);
        let s = PyDict::new(py);
        let e = PyDict::new(py);
        return Ok(PyTuple::new(py, &[d.into_any(), s.into_any(), e.into_any()])?);
    }

    let order = build_order(cases, ts);

    let first = order[0] as usize;
    let mut prev_case = cases[first];
    let mut prev_act = acts[first] as usize;
    start_counts[prev_act] += 1;

    for &idx in &order[1..] {
        let idx = idx as usize;
        let cur_case = cases[idx];
        let cur_act = acts[idx] as usize;

        if cur_case == prev_case {
            dfg_counts[prev_act * n_acts + cur_act] += 1;
        } else {
            end_counts[prev_act] += 1;
            start_counts[cur_act] += 1;
        }
        prev_case = cur_case;
        prev_act = cur_act;
    }
    end_counts[prev_act] += 1;

    let dfg_dict = PyDict::new(py);
    for from_id in 0..n_acts {
        for to_id in 0..n_acts {
            let c = dfg_counts[from_id * n_acts + to_id];
            if c > 0 {
                let key = PyTuple::new(py, &[&act_labels[from_id], &act_labels[to_id]])?;
                dfg_dict.set_item(key, c)?;
            }
        }
    }

    let sa_dict = PyDict::new(py);
    for (i, &c) in start_counts.iter().enumerate() {
        if c > 0 {
            sa_dict.set_item(&act_labels[i], c)?;
        }
    }
    let ea_dict = PyDict::new(py);
    for (i, &c) in end_counts.iter().enumerate() {
        if c > 0 {
            ea_dict.set_item(&act_labels[i], c)?;
        }
    }

    Ok(PyTuple::new(py, &[dfg_dict.into_any(), sa_dict.into_any(), ea_dict.into_any()])?)
}

// ── Performance DFG ─────────────────────────────────────────────────

/// Discover a performance DFG with per-edge mean durations (seconds).
/// Returns (perf_dfg_dict, start_activities, end_activities).
#[pyfunction]
fn discover_performance_dfg<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyTuple>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let mut edge_durations: Vec<Vec<f64>> = vec![Vec::new(); n_acts * n_acts];
    let mut start_counts = vec![0u64; n_acts];
    let mut end_counts = vec![0u64; n_acts];

    if n == 0 {
        let d = PyDict::new(py);
        let s = PyDict::new(py);
        let e = PyDict::new(py);
        return Ok(PyTuple::new(py, &[d.into_any(), s.into_any(), e.into_any()])?);
    }

    let order = build_order(cases, ts);

    let first = order[0] as usize;
    let mut prev_case = cases[first];
    let mut prev_act = acts[first] as usize;
    let mut prev_ts = ts[first];
    start_counts[prev_act] += 1;

    for &idx in &order[1..] {
        let idx = idx as usize;
        let cur_case = cases[idx];
        let cur_act = acts[idx] as usize;
        let cur_ts = ts[idx];

        if cur_case == prev_case {
            let dur_secs = (cur_ts - prev_ts) as f64 / 1_000_000_000.0;
            edge_durations[prev_act * n_acts + cur_act].push(dur_secs);
        } else {
            end_counts[prev_act] += 1;
            start_counts[cur_act] += 1;
        }
        prev_case = cur_case;
        prev_act = cur_act;
        prev_ts = cur_ts;
    }
    end_counts[prev_act] += 1;

    let dfg_dict = PyDict::new(py);
    for from_id in 0..n_acts {
        for to_id in 0..n_acts {
            let durs = &mut edge_durations[from_id * n_acts + to_id];
            if durs.is_empty() {
                continue;
            }
            let sum: f64 = durs.iter().sum();
            let mean = sum / durs.len() as f64;
            let stats = PyDict::new(py);
            stats.set_item("mean", mean)?;
            let key = PyTuple::new(py, &[&act_labels[from_id], &act_labels[to_id]])?;
            dfg_dict.set_item(key, stats)?;
        }
    }

    let sa_dict = PyDict::new(py);
    for (i, &c) in start_counts.iter().enumerate() {
        if c > 0 { sa_dict.set_item(&act_labels[i], c)?; }
    }
    let ea_dict = PyDict::new(py);
    for (i, &c) in end_counts.iter().enumerate() {
        if c > 0 { ea_dict.set_item(&act_labels[i], c)?; }
    }

    Ok(PyTuple::new(py, &[dfg_dict.into_any(), sa_dict.into_any(), ea_dict.into_any()])?)
}

// ── Variant analysis ────────────────────────────────────────────────

/// Group traces into variants with frequency and duration statistics.
/// Returns a list of dicts sorted by descending frequency.
#[pyfunction]
fn analyze_variants<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyList>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();

    if n == 0 {
        return Ok(PyList::empty(py));
    }

    let order = build_order(cases, ts);

    let mut variant_map: FxHashMap<Vec<u16>, (u32, Vec<f64>)> = FxHashMap::default();
    let mut case_acts: Vec<u16> = Vec::new();
    let mut case_start_ts: i64 = 0;
    let mut case_end_ts: i64 = 0;
    let mut prev_case: i32 = -1;

    let mut flush_case =
        |case_acts: &mut Vec<u16>, case_start_ts: i64, case_end_ts: i64,
         variant_map: &mut FxHashMap<Vec<u16>, (u32, Vec<f64>)>| {
            if case_acts.is_empty() { return; }
            let dur_secs = (case_end_ts - case_start_ts) as f64 / 1_000_000_000.0;
            let key = case_acts.clone();
            let entry = variant_map.entry(key).or_insert_with(|| (0, Vec::new()));
            entry.0 += 1;
            entry.1.push(dur_secs);
            case_acts.clear();
        };

    for &idx in &order {
        let idx = idx as usize;
        let cur_case = cases[idx];
        let cur_act = acts[idx] as u16;
        let cur_ts = ts[idx];

        if cur_case != prev_case {
            flush_case(&mut case_acts, case_start_ts, case_end_ts, &mut variant_map);
            case_start_ts = cur_ts;
            prev_case = cur_case;
        }
        case_acts.push(cur_act);
        case_end_ts = cur_ts;
    }
    flush_case(&mut case_acts, case_start_ts, case_end_ts, &mut variant_map);

    let total_cases: u32 = variant_map.values().map(|(f, _)| f).sum();
    let mut variants: Vec<(Vec<u16>, u32, Vec<f64>)> = variant_map
        .into_iter().map(|(k, (f, d))| (k, f, d)).collect();
    variants.sort_unstable_by(|a, b| b.1.cmp(&a.1));

    let result = PyList::empty(py);
    for (idx, (act_seq, freq, durations)) in variants.iter().enumerate() {
        let dict = PyDict::new(py);
        let activities: Vec<&str> = act_seq.iter().map(|&c| act_labels[c as usize].as_str()).collect();
        dict.set_item("activities", activities)?;
        dict.set_item("frequency", *freq)?;
        dict.set_item("percentage",
            if total_cases > 0 { (*freq as f64 / total_cases as f64) * 100.0 } else { 0.0 }
        )?;
        dict.set_item("id", idx + 1)?;

        if durations.is_empty() {
            dict.set_item("avg_duration", py.None())?;
            dict.set_item("min_duration", py.None())?;
            dict.set_item("max_duration", py.None())?;
        } else {
            let sum: f64 = durations.iter().sum();
            dict.set_item("avg_duration", sum / durations.len() as f64)?;
            dict.set_item("min_duration", durations.iter().cloned().fold(f64::INFINITY, f64::min))?;
            dict.set_item("max_duration", durations.iter().cloned().fold(f64::NEG_INFINITY, f64::max))?;
        }
        result.append(dict)?;
    }
    Ok(result)
}

// ── Edge durations ──────────────────────────────────────────────────

/// Compute per-edge avg and median durations (seconds).
/// Replaces the iterrows()-based Python implementation.
#[pyfunction]
fn compute_edge_durations<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let result = PyDict::new(py);
    if n == 0 { return Ok(result); }

    let order = build_order(cases, ts);
    let mut edge_durs: Vec<Vec<f64>> = vec![Vec::new(); n_acts * n_acts];

    let first = order[0] as usize;
    let mut prev_case = cases[first];
    let mut prev_act = acts[first] as usize;
    let mut prev_ts = ts[first];

    for &idx in &order[1..] {
        let idx = idx as usize;
        let cur_case = cases[idx];
        let cur_act = acts[idx] as usize;
        let cur_ts = ts[idx];
        if cur_case == prev_case {
            let dur = (cur_ts - prev_ts) as f64 / 1_000_000_000.0;
            edge_durs[prev_act * n_acts + cur_act].push(dur);
        }
        prev_case = cur_case;
        prev_act = cur_act;
        prev_ts = cur_ts;
    }

    for from_id in 0..n_acts {
        for to_id in 0..n_acts {
            let durs = &mut edge_durs[from_id * n_acts + to_id];
            if durs.is_empty() { continue; }
            let sum: f64 = durs.iter().sum();
            let avg = sum / durs.len() as f64;
            let med = median_sorted(durs);
            let stats = PyDict::new(py);
            stats.set_item("avg", avg)?;
            stats.set_item("median", med)?;
            let key = PyTuple::new(py, &[&act_labels[from_id], &act_labels[to_id]])?;
            result.set_item(key, stats)?;
        }
    }
    Ok(result)
}

// ── Eventually-Follows Graph ────────────────────────────────────────

/// Compute all eventually-follows pairs with occurrence counts.
/// Uses right-to-left suffix counting per case.
#[pyfunction]
fn compute_efg<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let result = PyDict::new(py);
    if n == 0 { return Ok(result); }

    let order = build_order(cases, ts);
    let mut efg_counts: Vec<u64> = vec![0; n_acts * n_acts];
    let mut suffix = vec![0u64; n_acts];

    let mut trace_start: usize = 0;
    let mut cur_case = cases[order[0] as usize];

    for i in 0..=order.len() {
        let new_case = if i < order.len() { cases[order[i] as usize] != cur_case } else { true };
        if new_case {
            suffix.iter_mut().for_each(|x| *x = 0);
            for j in (trace_start..i).rev() {
                let act = acts[order[j] as usize] as usize;
                for b in 0..n_acts {
                    if suffix[b] > 0 { efg_counts[act * n_acts + b] += suffix[b]; }
                }
                suffix[act] += 1;
            }
            if i < order.len() { trace_start = i; cur_case = cases[order[i] as usize]; }
        }
    }

    for a in 0..n_acts {
        for b in 0..n_acts {
            let c = efg_counts[a * n_acts + b];
            if c > 0 {
                let key = PyTuple::new(py, &[&act_labels[a], &act_labels[b]])?;
                result.set_item(key, c)?;
            }
        }
    }
    Ok(result)
}

// ── Token-based replay fitness ──────────────────────────────────────

/// Recursively enable a transition by firing silent transitions that
/// produce tokens into needed places. Backward search through the net
/// structure — efficient for Inductive Miner's tree-structured nets.
fn try_enable(
    needed_places: &[usize],
    marking: &mut [i32],
    transitions: &[(String, Vec<usize>, Vec<usize>)],
    place_producers: &[Vec<usize>],
    consumed: &mut i64,
    produced: &mut i64,
    visited: &mut [bool],
) -> bool {
    for &p in needed_places {
        if marking[p] > 0 { continue; }
        let mut resolved = false;
        for &si in &place_producers[p] {
            if visited[si] { continue; }
            visited[si] = true;
            let sinp = &transitions[si].1;
            let sout = &transitions[si].2;
            if try_enable(sinp, marking, transitions, place_producers, consumed, produced, visited) {
                for &sp in sinp { marking[sp] -= 1; *consumed += 1; }
                for &sp in sout { marking[sp] += 1; *produced += 1; }
                if marking[p] > 0 { resolved = true; break; }
            }
        }
        if !resolved { return false; }
    }
    needed_places.iter().all(|&p| marking[p] > 0)
}

/// Token-based replay with silent transition support.
///
/// Accepts:
///   traces       – list[list[str]] activity sequences per case
///   transitions  – list[(label, input_place_ids, output_place_ids)]
///                  label="" for silent/tau transitions
///   n_places     – total places in the net
///   im_places    – initial marking place ids
///   fm_places    – final marking place ids
#[pyfunction]
fn token_replay_fitness<'py>(
    py: Python<'py>,
    traces: Vec<Vec<String>>,
    transitions: Vec<(String, Vec<usize>, Vec<usize>)>,
    n_places: usize,
    im_places: Vec<usize>,
    fm_places: Vec<usize>,
) -> PyResult<Bound<'py, PyDict>> {
    let n_trans = transitions.len();

    let mut label_to_trans: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
    let mut silent_trans: Vec<usize> = Vec::new();
    for (i, (label, _, _)) in transitions.iter().enumerate() {
        if label.is_empty() { silent_trans.push(i); }
        else { label_to_trans.entry(label.as_str()).or_default().push(i); }
    }

    let mut place_producers: Vec<Vec<usize>> = vec![Vec::new(); n_places];
    for &si in &silent_trans {
        for &p in &transitions[si].2 { place_producers[p].push(si); }
    }

    let total_cases = traces.len();
    let per_trace = PyList::empty(py);
    let mut fitness_sum = 0.0;
    let mut conformant = 0u64;
    let mut marking = vec![0i32; n_places];
    let mut visited = vec![false; n_trans];

    for trace in &traces {
        marking.iter_mut().for_each(|x| *x = 0);
        for &p in &im_places { marking[p] = 1; }
        let mut missing: i64 = 0;
        let mut consumed: i64 = 0;
        let mut remaining: i64 = 0;
        let mut produced: i64 = im_places.len() as i64;

        for activity in trace {
            if let Some(trans_ids) = label_to_trans.get(activity.as_str()) {
                let mut chosen = trans_ids[0];
                let mut is_enabled = false;

                // Check if any labeled transition is directly enabled
                for &tid in trans_ids {
                    if transitions[tid].1.iter().all(|&p| marking[p] > 0) {
                        chosen = tid; is_enabled = true; break;
                    }
                }

                // Try backward search through silent transitions
                if !is_enabled {
                    for &tid in trans_ids {
                        visited.iter_mut().for_each(|x| *x = false);
                        if try_enable(&transitions[tid].1, &mut marking, &transitions,
                                      &place_producers, &mut consumed, &mut produced, &mut visited) {
                            chosen = tid; is_enabled = true; break;
                        }
                    }
                }

                let (_, ref inp, ref out) = transitions[chosen];
                if !is_enabled {
                    for &p in inp { if marking[p] <= 0 { missing += 1; marking[p] += 1; } }
                }
                for &p in inp { marking[p] -= 1; consumed += 1; }
                for &p in out { marking[p] += 1; produced += 1; }
            }
        }

        // Route tokens toward final marking
        visited.iter_mut().for_each(|x| *x = false);
        try_enable(&fm_places, &mut marking, &transitions, &place_producers,
                   &mut consumed, &mut produced, &mut visited);

        for (p, &tokens) in marking.iter().enumerate() {
            if tokens > 0 {
                let expected = if fm_places.contains(&p) { 1 } else { 0 };
                let leftover = tokens - expected;
                if leftover > 0 { remaining += leftover as i64; }
            }
        }
        for &p in &fm_places { if marking[p] <= 0 { missing += 1; } }

        let denom = (consumed + produced) as f64;
        let trace_fitness = if denom > 0.0 {
            (1.0 - (missing + remaining) as f64 / denom).clamp(0.0, 1.0)
        } else { 0.0 };

        let is_fit = missing == 0 && remaining == 0;
        if is_fit { conformant += 1; }
        fitness_sum += trace_fitness;

        let d = PyDict::new(py);
        d.set_item("missing_tokens", missing)?;
        d.set_item("remaining_tokens", remaining)?;
        d.set_item("consumed_tokens", consumed)?;
        d.set_item("produced_tokens", produced)?;
        d.set_item("trace_is_fit", is_fit)?;
        d.set_item("trace_fitness", trace_fitness)?;
        per_trace.append(d)?;
    }

    let avg_fitness = if total_cases > 0 { fitness_sum / total_cases as f64 } else { 0.0 };
    let result = PyDict::new(py);
    result.set_item("average_trace_fitness", avg_fitness)?;
    result.set_item("conformant_cases", conformant)?;
    result.set_item("total_cases", total_cases)?;
    result.set_item("per_trace", per_trace)?;
    Ok(result)
}

// ── Activity durations ──────────────────────────────────────────────

/// Per-activity avg and median duration to the next event (seconds).
/// Returns dict[str → {"avg": float, "median": float}].
#[pyfunction]
fn compute_activity_durations<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let result = PyDict::new(py);
    if n == 0 { return Ok(result); }

    let order = build_order(cases, ts);
    let mut act_durs: Vec<Vec<f64>> = vec![Vec::new(); n_acts];

    let first = order[0] as usize;
    let mut prev_case = cases[first];
    let mut prev_act = acts[first] as usize;
    let mut prev_ts = ts[first];

    for &idx in &order[1..] {
        let idx = idx as usize;
        let cur_case = cases[idx];
        let cur_ts = ts[idx];
        if cur_case == prev_case {
            let dur = (cur_ts - prev_ts) as f64 / 1_000_000_000.0;
            act_durs[prev_act].push(dur);
        }
        prev_case = cur_case;
        prev_act = acts[idx] as usize;
        prev_ts = cur_ts;
    }

    for (i, durs) in act_durs.iter_mut().enumerate() {
        if durs.is_empty() { continue; }
        let sum: f64 = durs.iter().sum();
        let avg = sum / durs.len() as f64;
        let med = median_sorted(durs);
        let stats = PyDict::new(py);
        stats.set_item("avg", avg)?;
        stats.set_item("median", med)?;
        result.set_item(&act_labels[i], stats)?;
    }
    Ok(result)
}

// ── Precision (ETC) ─────────────────────────────────────────────────

/// ETC precision (Muñoz-Gama & Carmona).
///
/// For each unique prefix observed in the log:
///   1. Replay it through the net to reach a marking
///   2. Find which activities are enabled at that marking
///   3. Find which activities actually follow this prefix in the log
///   4. escaping_edges = enabled − actually_followed
///   5. precision = 1 − Σ(escaping) / Σ(enabled)
///
/// Returns a float in [0, 1].
#[pyfunction]
fn compute_precision_etc(
    traces: Vec<Vec<String>>,
    transitions: Vec<(String, Vec<usize>, Vec<usize>)>,
    n_places: usize,
    im_places: Vec<usize>,
    _fm_places: Vec<usize>,
) -> PyResult<f64> {
    let n_trans = transitions.len();

    let mut label_to_trans: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
    let mut silent_trans: Vec<usize> = Vec::new();
    for (i, (label, _, _)) in transitions.iter().enumerate() {
        if label.is_empty() { silent_trans.push(i); }
        else { label_to_trans.entry(label.as_str()).or_default().push(i); }
    }

    let mut place_producers: Vec<Vec<usize>> = vec![Vec::new(); n_places];
    for &si in &silent_trans {
        for &p in &transitions[si].2 { place_producers[p].push(si); }
    }

    let all_labels: Vec<&str> = label_to_trans.keys().copied().collect();

    // Build unique prefixes → (count, set of follower activities)
    // prefix is a Vec<&str>, followers is a set of activity strings
    let mut prefix_data: FxHashMap<Vec<&str>, (u64, Vec<bool>)> = FxHashMap::default();
    let n_labels = all_labels.len();
    let label_idx: FxHashMap<&str, usize> = all_labels.iter().enumerate().map(|(i, &l)| (l, i)).collect();

    for trace in &traces {
        for prefix_len in 0..trace.len() {
            let prefix: Vec<&str> = trace[..prefix_len].iter().map(|s| s.as_str()).collect();
            let follower = trace[prefix_len].as_str();

            let entry = prefix_data.entry(prefix).or_insert_with(|| (0, vec![false; n_labels]));
            entry.0 += 1;
            if let Some(&idx) = label_idx.get(follower) {
                entry.1[idx] = true;
            }
        }
    }

    // Also handle the empty prefix (initial marking)
    let n_traces = traces.len() as u64;

    let mut sum_at: f64 = 0.0;
    let mut sum_ee: f64 = 0.0;
    let mut marking = vec![0i32; n_places];
    let mut visited = vec![false; n_trans];

    for (prefix, (count, followers)) in &prefix_data {
        // Replay prefix to reach a marking
        marking.iter_mut().for_each(|x| *x = 0);
        for &p in &im_places { marking[p] = 1; }

        let mut fit = true;
        for &act in prefix {
            if let Some(trans_ids) = label_to_trans.get(act) {
                let mut chosen = trans_ids[0];
                let mut is_enabled = false;
                for &tid in trans_ids {
                    if transitions[tid].1.iter().all(|&p| marking[p] > 0) {
                        chosen = tid; is_enabled = true; break;
                    }
                }
                if !is_enabled {
                    let mut dc = 0i64;
                    let mut dp = 0i64;
                    for &tid in trans_ids {
                        visited.iter_mut().for_each(|x| *x = false);
                        if try_enable(&transitions[tid].1, &mut marking, &transitions,
                                      &place_producers, &mut dc, &mut dp, &mut visited) {
                            chosen = tid; is_enabled = true; break;
                        }
                    }
                }
                if !is_enabled {
                    fit = false;
                    break;
                }
                for &p in &transitions[chosen].1 { marking[p] -= 1; }
                for &p in &transitions[chosen].2 { marking[p] += 1; }
            } else {
                fit = false;
                break;
            }
        }

        if !fit { continue; }

        // Find enabled activities at this marking
        let mut enabled = vec![false; n_labels];
        for (li, &label) in all_labels.iter().enumerate() {
            if let Some(trans_ids) = label_to_trans.get(label) {
                let mut can_fire = false;
                for &tid in trans_ids {
                    if transitions[tid].1.iter().all(|&p| marking[p] > 0) {
                        can_fire = true; break;
                    }
                }
                if !can_fire {
                    // Try via silent transitions on a test marking
                    for &tid in trans_ids {
                        visited.iter_mut().for_each(|x| *x = false);
                        let mut test_m = marking.clone();
                        let mut dc = 0i64;
                        let mut dp = 0i64;
                        if try_enable(&transitions[tid].1, &mut test_m, &transitions,
                                      &place_producers, &mut dc, &mut dp, &mut visited) {
                            can_fire = true; break;
                        }
                    }
                }
                enabled[li] = can_fire;
            }
        }

        let n_enabled: u64 = enabled.iter().filter(|&&e| e).count() as u64;
        let n_escaping: u64 = enabled.iter().zip(followers.iter())
            .filter(|(&en, &followed)| en && !followed).count() as u64;

        let c = *count as f64;
        sum_at += c * n_enabled as f64;
        sum_ee += c * n_escaping as f64;
    }

    Ok(if sum_at > 0.0 { 1.0 - sum_ee / sum_at } else { 1.0 })
}

// ── Heuristic Miner ─────────────────────────────────────────────────

/// Heuristic Miner: builds a dependency graph from the DFG, applies
/// thresholds, and constructs a Petri net.
///
/// Returns a dict with:
///   places:           list[str]
///   transitions:      list[{"name": str, "label": str|None}]
///   arcs:             list[{"source": str, "target": str}]
///   initial_marking:  list[str]   (place names)
///   final_marking:    list[str]   (place names)
#[pyfunction]
fn discover_petri_net_heuristics<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
    dependency_threshold: f64,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    // Step 1: compute DFG + start/end activities
    let order = build_order(cases, ts);
    let mut dfg = vec![0i64; n_acts * n_acts];
    let mut start_counts = vec![0u64; n_acts];
    let mut end_counts = vec![0u64; n_acts];

    if n > 0 {
        let first = order[0] as usize;
        let mut prev_case = cases[first];
        let mut prev_act = acts[first] as usize;
        start_counts[prev_act] += 1;

        for &idx in &order[1..] {
            let idx = idx as usize;
            let cur_case = cases[idx];
            let cur_act = acts[idx] as usize;
            if cur_case == prev_case {
                dfg[prev_act * n_acts + cur_act] += 1;
            } else {
                end_counts[prev_act] += 1;
                start_counts[cur_act] += 1;
            }
            prev_case = cur_case;
            prev_act = cur_act;
        }
        end_counts[acts[order[n - 1] as usize] as usize] += 1;
    }

    // Step 2: compute dependency matrix
    // dep(a,b) = (|a>b| - |b>a|) / (|a>b| + |b>a| + 1)
    // Self-loops: dep(a,a) = |a>a| / (|a>a| + 1)
    let mut dep = vec![0.0f64; n_acts * n_acts];
    for a in 0..n_acts {
        for b in 0..n_acts {
            let ab = dfg[a * n_acts + b] as f64;
            if a == b {
                dep[a * n_acts + b] = ab / (ab + 1.0);
            } else {
                let ba = dfg[b * n_acts + a] as f64;
                dep[a * n_acts + b] = (ab - ba) / (ab + ba + 1.0);
            }
        }
    }

    // Step 3: apply threshold — keep edges where dep >= threshold AND freq > 0
    let mut kept_edges: Vec<(usize, usize)> = Vec::new();
    for a in 0..n_acts {
        for b in 0..n_acts {
            if dep[a * n_acts + b] >= dependency_threshold && dfg[a * n_acts + b] > 0 {
                kept_edges.push((a, b));
            }
        }
    }

    // Determine which activities survive (have at least one edge)
    let mut active = vec![false; n_acts];
    for &(a, b) in &kept_edges {
        active[a] = true;
        active[b] = true;
    }
    // Start/end activities are always active
    for i in 0..n_acts {
        if start_counts[i] > 0 || end_counts[i] > 0 { active[i] = true; }
    }

    // Step 4: construct Petri net
    // Simple construction: source place → each transition → sink place
    // with intermediate places for edges
    let mut places: Vec<String> = Vec::new();
    let mut trans_list: Vec<(String, Option<String>)> = Vec::new(); // (name, label)
    let mut arcs: Vec<(String, String)> = Vec::new(); // (source, target)

    let source = "source".to_string();
    let sink = "sink".to_string();
    places.push(source.clone());
    places.push(sink.clone());

    // Create a transition for each active activity
    let mut act_trans_name: Vec<String> = vec![String::new(); n_acts];
    for i in 0..n_acts {
        if !active[i] { continue; }
        let tname = format!("t_{}", act_labels[i]);
        act_trans_name[i] = tname.clone();
        trans_list.push((tname, Some(act_labels[i].clone())));
    }

    // For each edge (a→b), create an intermediate place
    // and arcs: t_a → p_a_b → t_b
    let mut out_places: Vec<Vec<String>> = vec![Vec::new(); n_acts];
    let mut in_places: Vec<Vec<String>> = vec![Vec::new(); n_acts];

    for &(a, b) in &kept_edges {
        if a == b { continue; } // self-loops handled separately
        let pname = format!("p_{}_{}", act_labels[a], act_labels[b]);
        places.push(pname.clone());
        arcs.push((act_trans_name[a].clone(), pname.clone()));
        arcs.push((pname.clone(), act_trans_name[b].clone()));
        out_places[a].push(pname.clone());
        in_places[b].push(pname);
    }

    // Connect source to start activities
    for i in 0..n_acts {
        if start_counts[i] > 0 && active[i] {
            if in_places[i].is_empty() {
                // Direct from source
                arcs.push((source.clone(), act_trans_name[i].clone()));
            }
        }
    }
    // If no start activity has a direct source connection, add one
    let has_source_arc = arcs.iter().any(|(s, _)| s == "source");
    if !has_source_arc {
        // Connect source to the most frequent start activity
        if let Some(best) = (0..n_acts).filter(|&i| start_counts[i] > 0 && active[i]).max_by_key(|&i| start_counts[i]) {
            arcs.push((source.clone(), act_trans_name[best].clone()));
        }
    }

    // Connect end activities to sink
    for i in 0..n_acts {
        if end_counts[i] > 0 && active[i] {
            if out_places[i].is_empty() {
                arcs.push((act_trans_name[i].clone(), sink.clone()));
            }
        }
    }
    let has_sink_arc = arcs.iter().any(|(_, t)| t == "sink");
    if !has_sink_arc {
        if let Some(best) = (0..n_acts).filter(|&i| end_counts[i] > 0 && active[i]).max_by_key(|&i| end_counts[i]) {
            arcs.push((act_trans_name[best].clone(), sink.clone()));
        }
    }

    // Build result dict
    let result = PyDict::new(py);

    let py_places = PyList::empty(py);
    for p in &places { py_places.append(p)?; }
    result.set_item("places", py_places)?;

    let py_trans = PyList::empty(py);
    for (name, label) in &trans_list {
        let d = PyDict::new(py);
        d.set_item("name", name)?;
        match label {
            Some(l) => d.set_item("label", l)?,
            None => d.set_item("label", py.None())?,
        }
        py_trans.append(d)?;
    }
    result.set_item("transitions", py_trans)?;

    let py_arcs = PyList::empty(py);
    for (s, t) in &arcs {
        let d = PyDict::new(py);
        d.set_item("source", s)?;
        d.set_item("target", t)?;
        py_arcs.append(d)?;
    }
    result.set_item("arcs", py_arcs)?;

    let py_im = PyList::empty(py);
    py_im.append(&source)?;
    result.set_item("initial_marking", py_im)?;

    let py_fm = PyList::empty(py);
    py_fm.append(&sink)?;
    result.set_item("final_marking", py_fm)?;

    Ok(result)
}

// ── Temporal profile ────────────────────────────────────────────────

/// Compute mean/stdev of time between every eventually-follows pair
/// and flag deviations at zeta=2.0.
///
/// Two-pass algorithm:
///   Pass 1: accumulate per-pair (count, sum_dt, sum_dt²) using the
///           running-seen trick (O(N·k) per case).
///   Pass 2: walk each case again, flag pairs where z-score > zeta.
///
/// Returns dict with "profiles" and "deviations" lists.
#[pyfunction]
fn compute_temporal_profile<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let order = build_order(cases, ts);

    // Per-pair accumulators: [count, sum_dt, sum_dt2]
    let mut pp_count = vec![0u64; n_acts * n_acts];
    let mut pp_sum = vec![0.0f64; n_acts * n_acts];
    let mut pp_sum2 = vec![0.0f64; n_acts * n_acts];

    // Per-activity running accumulators within a case: [count, sum_t, sum_t2]
    let mut seen_cnt = vec![0u64; n_acts];
    let mut seen_sum = vec![0.0f64; n_acts];
    let mut seen_sum2 = vec![0.0f64; n_acts];

    // Also collect per-case event lists for pass 2
    let mut case_events: Vec<Vec<(usize, f64)>> = Vec::new();
    let mut case_labels: Vec<i32> = Vec::new();

    let mut cur_events: Vec<(usize, f64)> = Vec::new();
    let mut prev_case: i32 = -1;

    let flush_pass1 = |cur: &mut Vec<(usize, f64)>,
                       seen_cnt: &mut [u64], seen_sum: &mut [f64], seen_sum2: &mut [f64],
                       pp_count: &mut [u64], pp_sum: &mut [f64], pp_sum2: &mut [f64],
                       n_acts: usize,
                       case_events: &mut Vec<Vec<(usize, f64)>>| {
        if cur.is_empty() { return; }
        seen_cnt.iter_mut().for_each(|x| *x = 0);
        seen_sum.iter_mut().for_each(|x| *x = 0.0);
        seen_sum2.iter_mut().for_each(|x| *x = 0.0);

        for &(act_b, tb) in cur.iter() {
            for a in 0..n_acts {
                let cnt = seen_cnt[a];
                if cnt == 0 { continue; }
                let s = seen_sum[a];
                let s2 = seen_sum2[a];
                let sum_dt = cnt as f64 * tb - s;
                let sum_dt2 = cnt as f64 * tb * tb - 2.0 * tb * s + s2;
                let idx = a * n_acts + act_b;
                pp_count[idx] += cnt;
                pp_sum[idx] += sum_dt;
                pp_sum2[idx] += sum_dt2;
            }
            seen_cnt[act_b] += 1;
            seen_sum[act_b] += tb;
            seen_sum2[act_b] += tb * tb;
        }
        case_events.push(cur.clone());
        cur.clear();
    };

    for &idx in &order {
        let idx = idx as usize;
        let c = cases[idx];
        let a = acts[idx] as usize;
        let t_sec = ts[idx] as f64 / 1_000_000_000.0;

        if c != prev_case {
            flush_pass1(&mut cur_events, &mut seen_cnt, &mut seen_sum, &mut seen_sum2,
                       &mut pp_count, &mut pp_sum, &mut pp_sum2, n_acts, &mut case_events);
            case_labels.push(c);
            prev_case = c;
        }
        cur_events.push((a, t_sec));
    }
    flush_pass1(&mut cur_events, &mut seen_cnt, &mut seen_sum, &mut seen_sum2,
               &mut pp_count, &mut pp_sum, &mut pp_sum2, n_acts, &mut case_events);

    // Build profiles (mean, stdev)
    let mut means = vec![0.0f64; n_acts * n_acts];
    let mut stdevs = vec![0.0f64; n_acts * n_acts];
    let profiles = PyList::empty(py);

    for a in 0..n_acts {
        for b in 0..n_acts {
            let idx = a * n_acts + b;
            let cnt = pp_count[idx];
            if cnt == 0 { continue; }
            let mean = pp_sum[idx] / cnt as f64;
            let stdev = if cnt > 1 {
                let var = (pp_sum2[idx] - cnt as f64 * mean * mean) / (cnt - 1) as f64;
                var.max(0.0).sqrt()
            } else { 0.0 };
            means[idx] = mean;
            stdevs[idx] = stdev;

            let d = PyDict::new(py);
            d.set_item("source", &act_labels[a])?;
            d.set_item("target", &act_labels[b])?;
            d.set_item("mean", mean)?;
            d.set_item("stdev", stdev)?;
            profiles.append(d)?;
        }
    }

    // Pass 2: flag deviations
    let zeta = 2.0f64;
    let deviations = PyList::empty(py);
    let mut seen_first = vec![f64::NAN; n_acts];
    let mut seen_last = vec![f64::NAN; n_acts];
    let mut flagged = vec![false; n_acts * n_acts];

    for (ci, events) in case_events.iter().enumerate() {
        seen_first.iter_mut().for_each(|x| *x = f64::NAN);
        seen_last.iter_mut().for_each(|x| *x = f64::NAN);
        flagged.iter_mut().for_each(|x| *x = false);

        for &(act_b, tb) in events {
            for a in 0..n_acts {
                if seen_first[a].is_nan() { continue; }
                let pair = a * n_acts + act_b;
                if flagged[pair] { continue; }
                let sd = stdevs[pair];
                if sd == 0.0 { continue; }
                let mean = means[pair];
                if mean == 0.0 && sd == 0.0 { continue; }

                let d_old = tb - seen_first[a];
                let d_new = tb - seen_last[a];
                let (delta, z) = if (d_old - mean).abs() > (d_new - mean).abs() {
                    (d_old, (d_old - mean).abs() / sd)
                } else {
                    (d_new, (d_new - mean).abs() / sd)
                };

                if z > zeta {
                    let d = PyDict::new(py);
                    d.set_item("case_id", case_labels[ci].to_string())?;
                    let pair_list = PyList::empty(py);
                    pair_list.append(&act_labels[a])?;
                    pair_list.append(&act_labels[act_b])?;
                    d.set_item("activity_pair", pair_list)?;
                    d.set_item("expected", mean)?;
                    d.set_item("actual", delta)?;
                    d.set_item("is_deviation", true)?;
                    deviations.append(d)?;
                    flagged[pair] = true;
                }
            }
            if seen_first[act_b].is_nan() { seen_first[act_b] = tb; }
            seen_last[act_b] = tb;
        }
    }

    let result = PyDict::new(py);
    result.set_item("profiles", profiles)?;
    result.set_item("deviations", deviations)?;
    Ok(result)
}

// ── Bottleneck analysis ─────────────────────────────────────────────

/// Compute per-activity duration stats and per-edge waiting times.
/// Returns dict with "bottlenecks" and "waiting_times" lists.
#[pyfunction]
fn compute_bottlenecks<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let order = build_order(cases, ts);

    // Collect per-activity durations and per-edge durations
    let mut act_durs: Vec<Vec<f64>> = vec![Vec::new(); n_acts];
    let mut edge_durs: Vec<Vec<f64>> = vec![Vec::new(); n_acts * n_acts];

    if n > 0 {
        let first = order[0] as usize;
        let mut prev_case = cases[first];
        let mut prev_act = acts[first] as usize;
        let mut prev_ts = ts[first];

        for &idx in &order[1..] {
            let idx = idx as usize;
            let cur_case = cases[idx];
            let cur_act = acts[idx] as usize;
            let cur_ts = ts[idx];
            if cur_case == prev_case {
                let dur = (cur_ts - prev_ts) as f64 / 1_000_000_000.0;
                act_durs[prev_act].push(dur);
                edge_durs[prev_act * n_acts + cur_act].push(dur);
            }
            prev_case = cur_case;
            prev_act = cur_act;
            prev_ts = cur_ts;
        }
    }

    // Build activity stats
    let mut activity_stats: Vec<(usize, f64, f64, usize)> = Vec::new(); // (act, avg, median, freq)
    for i in 0..n_acts {
        let durs = &mut act_durs[i];
        if durs.is_empty() { continue; }
        let sum: f64 = durs.iter().sum();
        let avg = sum / durs.len() as f64;
        let med = median_sorted(durs);
        activity_stats.push((i, avg, med, durs.len()));
    }

    // Compute percentiles for bottleneck classification
    let freq_total: usize = activity_stats.iter().map(|s| s.3).sum();
    let freq_threshold = (freq_total as f64 * 0.005).max(5.0) as usize;
    let mut repr_avgs: Vec<f64> = activity_stats.iter()
        .filter(|s| s.3 >= freq_threshold)
        .map(|s| s.1).collect();
    if repr_avgs.is_empty() {
        repr_avgs = activity_stats.iter().map(|s| s.1).collect();
    }
    repr_avgs.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    let percentile = |p: f64| -> f64 {
        if repr_avgs.is_empty() { return 0.0; }
        let idx = (p / 100.0 * (repr_avgs.len() - 1) as f64).round() as usize;
        repr_avgs[idx.min(repr_avgs.len() - 1)]
    };
    let p75 = percentile(75.0);
    let p90 = percentile(90.0);
    let p95 = percentile(95.0);

    let bottlenecks = PyList::empty(py);
    // Sort: bottlenecks first (by dur desc), then non-bottlenecks
    let mut sorted_stats = activity_stats.clone();
    sorted_stats.sort_by(|a, b| {
        let a_bn = a.3 >= freq_threshold && a.1 > p75;
        let b_bn = b.3 >= freq_threshold && b.1 > p75;
        b_bn.cmp(&a_bn).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
    });

    for &(act, avg, med, freq) in &sorted_stats {
        let (severity, is_bn) = if freq < freq_threshold {
            ("low", false)
        } else if avg > p95 { ("critical", true) }
        else if avg > p90 { ("high", true) }
        else if avg > p75 { ("medium", true) }
        else { ("low", false) };

        let d = PyDict::new(py);
        d.set_item("activity", &act_labels[act])?;
        d.set_item("avg_duration", avg)?;
        d.set_item("median_duration", med)?;
        d.set_item("frequency", freq)?;
        d.set_item("is_bottleneck", is_bn)?;
        d.set_item("severity", severity)?;
        bottlenecks.append(d)?;
    }

    // Waiting times per edge
    let waiting_times = PyList::empty(py);
    let mut wt_list: Vec<(usize, usize, f64, f64, f64, usize)> = Vec::new();
    for a in 0..n_acts {
        for b in 0..n_acts {
            let durs = &mut edge_durs[a * n_acts + b];
            if durs.is_empty() { continue; }
            let sum: f64 = durs.iter().sum();
            let avg = sum / durs.len() as f64;
            let med = median_sorted(durs);
            let max_val = durs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            wt_list.push((a, b, avg, med, max_val, durs.len()));
        }
    }
    wt_list.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    for &(a, b, avg, med, max_val, freq) in &wt_list {
        let d = PyDict::new(py);
        d.set_item("source", &act_labels[a])?;
        d.set_item("target", &act_labels[b])?;
        d.set_item("avg_waiting", avg)?;
        d.set_item("median_waiting", med)?;
        d.set_item("max_waiting", max_val)?;
        d.set_item("frequency", freq)?;
        waiting_times.append(d)?;
    }

    let result = PyDict::new(py);
    result.set_item("bottlenecks", bottlenecks)?;
    result.set_item("waiting_times", waiting_times)?;
    Ok(result)
}

// ── Social Network Analysis ─────────────────────────────────────────

/// Compute SNA matrices: handover, working_together, or subcontracting.
///
/// Accepts resource codes (categorical-encoded like case/activity) plus
/// a network_type string.
///
/// Returns dict with "resources" (list[str]), "matrix" (list[list[float]]),
/// "network_type" (str).
#[pyfunction]
fn compute_sna<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    res_codes: PyReadonlyArray1<'py, i32>,
    res_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
    network_type: &str,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let _acts = act_codes.as_slice()?;
    let resources = res_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_res = res_labels.len();

    let order = build_order(cases, ts);
    let mut matrix = vec![0.0f64; n_res * n_res];

    match network_type {
        "handover" => {
            // Handover of work: consecutive resource pairs (including same-resource),
            // globally normalized. Matches pm4py's variant-weighted algorithm when
            // beta=0 (default): for each consecutive pair in each case, add 1.
            if n > 0 {
                let first = order[0] as usize;
                let mut prev_case = cases[first];
                let mut prev_res = resources[first] as usize;
                for &idx in &order[1..] {
                    let idx = idx as usize;
                    let cur_case = cases[idx];
                    let cur_res = resources[idx] as usize;
                    if cur_case == prev_case {
                        matrix[prev_res * n_res + cur_res] += 1.0;
                    }
                    prev_case = cur_case;
                    prev_res = cur_res;
                }
            }
            // Global normalization: divide every cell by total sum
            let total: f64 = matrix.iter().sum();
            if total > 0.0 {
                for v in matrix.iter_mut() { *v /= total; }
            }
        }
        "working_together" => {
            // Resources that work on the same case
            // For each case, find all unique resources, then increment
            // matrix[r1][r2] for each pair
            let mut case_start = 0usize;
            let mut cur_case = if n > 0 { cases[order[0] as usize] } else { -1 };
            let mut case_resources: Vec<bool> = vec![false; n_res];

            for i in 0..=order.len() {
                let new_case = if i < order.len() { cases[order[i] as usize] != cur_case } else { true };
                if new_case {
                    // Process case [case_start..i)
                    let active: Vec<usize> = (0..n_res).filter(|&r| case_resources[r]).collect();
                    for &r1 in &active {
                        for &r2 in &active {
                            if r1 != r2 {
                                matrix[r1 * n_res + r2] += 1.0;
                            }
                        }
                    }
                    case_resources.iter_mut().for_each(|x| *x = false);
                    if i < order.len() {
                        case_start = i;
                        cur_case = cases[order[i] as usize];
                    }
                }
                if i < order.len() {
                    case_resources[resources[order[i] as usize] as usize] = true;
                }
            }
        }
        "subcontracting" => {
            // Subcontracting: A delegates to B then B hands back to A
            // Pattern: events by resource A, then B, then A again in same case
            if n > 1 {
                let first = order[0] as usize;
                let mut pp_case = cases[first];
                let mut pp_res = resources[first] as usize;

                if order.len() > 1 {
                    let second = order[1] as usize;
                    let mut p_case = cases[second];
                    let mut p_res = resources[second] as usize;

                    for &idx in &order[2..] {
                        let idx = idx as usize;
                        let cur_case = cases[idx];
                        let cur_res = resources[idx] as usize;
                        // Check if all three events are in the same case
                        // and pattern is A→B→A (pp_res == cur_res, p_res != cur_res)
                        if cur_case == p_case && p_case == pp_case
                            && pp_res == cur_res && p_res != cur_res
                        {
                            matrix[pp_res * n_res + p_res] += 1.0;
                        }
                        pp_case = p_case;
                        pp_res = p_res;
                        p_case = cur_case;
                        p_res = cur_res;
                    }
                }
            }
        }
        _ => {}
    }

    // Build result
    let result = PyDict::new(py);
    let active_res: Vec<usize> = (0..n_res).filter(|&r| {
        (0..n_res).any(|c| matrix[r * n_res + c] > 0.0 || matrix[c * n_res + r] > 0.0)
    }).collect();

    let py_resources = PyList::empty(py);
    for &r in &active_res { py_resources.append(&res_labels[r])?; }
    result.set_item("resources", py_resources)?;

    let py_matrix = PyList::empty(py);
    for &r in &active_res {
        let row = PyList::empty(py);
        for &c in &active_res {
            row.append(matrix[r * n_res + c])?;
        }
        py_matrix.append(row)?;
    }
    result.set_item("matrix", py_matrix)?;
    result.set_item("network_type", network_type)?;

    Ok(result)
}

// ── Case overlap ────────────────────────────────────────────────────

/// Sweep-line case overlap: at each event, how many cases are active.
/// Returns list of overlap counts (one per event in temporal order).
#[pyfunction]
fn compute_case_overlap<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();

    if n == 0 {
        let result = PyDict::new(py);
        result.set_item("overlaps", PyList::empty(py))?;
        result.set_item("max_overlap", 0)?;
        result.set_item("avg_overlap", 0.0)?;
        return Ok(result);
    }

    // Find min/max timestamp per case
    let n_cases = cases.iter().copied().max().unwrap_or(0) as usize + 1;
    let mut case_min = vec![i64::MAX; n_cases];
    let mut case_max = vec![i64::MIN; n_cases];

    for i in 0..n {
        let c = cases[i] as usize;
        let t = ts[i];
        if t < case_min[c] { case_min[c] = t; }
        if t > case_max[c] { case_max[c] = t; }
    }

    // Collect valid case intervals in original case order
    let mut intervals: Vec<(i64, i64, usize)> = Vec::new(); // (start, end, case_idx)
    let mut case_order: Vec<usize> = Vec::new(); // preserves first-seen order
    // Build first-seen order from the data
    let mut seen = vec![false; n_cases];
    for i in 0..n {
        let c = cases[i] as usize;
        if !seen[c] && case_min[c] != i64::MAX {
            seen[c] = true;
            case_order.push(c);
        }
    }
    for &c in &case_order {
        intervals.push((case_min[c], case_max[c], c));
    }

    // pm4py algorithm: for each case, count how many other cases'
    // intervals overlap with it.
    // Overlap: case A overlaps with case B if A.start <= B.end AND B.start <= A.end
    //
    // Efficient O(n log n) sweep-line approach:
    // Sort intervals by start time. For each interval, count how many
    // previously-started intervals haven't ended yet (their end >= our start).
    // Then add intervals that start after our end (future starts that overlap).
    //
    // Actually, use sorted start/end events and for each case track active count.
    let n_intervals = intervals.len();
    let mut overlap_counts = vec![0i32; n_cases];

    // Sort by start time
    let mut sorted_intervals: Vec<(i64, i64, usize)> = intervals.clone();
    sorted_intervals.sort_unstable_by_key(|&(s, _, _)| s);

    // For each case, count overlapping intervals using sweep
    // Build events: (time, +1 for start, -1 for end)
    let mut events: Vec<(i64, i32)> = Vec::with_capacity(n_intervals * 2);
    for &(s, e, _) in &sorted_intervals {
        events.push((s, 1));
        events.push((e, -1));
    }
    events.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    // For each case: count = number of intervals where start <= case.end AND end >= case.start
    // Brute force for now (O(n²)) but fast in Rust — for 100k cases this is ~10 billion ops
    // which is too slow. Use sweep-line instead.
    //
    // Sweep-line: sort all start/end points. For each case, the overlap count is
    // the number of active intervals at any point during [case.start, case.end].
    // But pm4py counts intervals that INTERSECT, not active at a point.
    //
    // pm4py uses IntervalTree: for each case, query how many intervals overlap
    // with [case.start, case.end]. This is: count of intervals where
    // interval.start < case.end AND interval.end > case.start.
    //
    // Efficient approach: for each case i, count j where
    //   sorted_start[j] < end[i] AND sorted_end[j] > start[i]
    // = (total intervals) - (intervals starting after end[i]) - (intervals ending before start[i])
    // Use binary search on sorted arrays.

    let mut sorted_starts: Vec<i64> = sorted_intervals.iter().map(|&(s,_,_)| s).collect();
    let mut sorted_ends: Vec<i64> = sorted_intervals.iter().map(|&(_,e,_)| e).collect();
    sorted_ends.sort_unstable();
    // sorted_starts is already sorted (we sorted intervals by start)

    for &(s, e, c) in &intervals {
        // Count intervals where start < e (not <=, pm4py uses epsilon to make it strict)
        // and end > s
        let starts_before_end = sorted_starts.partition_point(|&x| x < e);
        let ends_after_start = n_intervals - sorted_ends.partition_point(|&x| x <= s);
        // Overlap = starts_before_end + ends_after_start - n_intervals
        // (inclusion-exclusion: intervals that satisfy BOTH conditions)
        let overlap = (starts_before_end + ends_after_start).saturating_sub(n_intervals);
        overlap_counts[c] = overlap as i32;
    }

    let overlaps: Vec<i32> = case_order.iter().map(|&c| overlap_counts[c]).collect();

    let max_overlap = overlaps.iter().copied().max().unwrap_or(0);
    let avg_overlap = if overlaps.is_empty() { 0.0 }
                      else { overlaps.iter().map(|&x| x as f64).sum::<f64>() / overlaps.len() as f64 };

    let result = PyDict::new(py);
    let py_overlaps = PyList::empty(py);
    for &o in &overlaps { py_overlaps.append(o)?; }
    result.set_item("overlaps", py_overlaps)?;
    result.set_item("max_overlap", max_overlap)?;
    result.set_item("avg_overlap", (avg_overlap * 1000.0).round() / 1000.0)?;
    Ok(result)
}

// ── Generalization (TBR) ────────────────────────────────────────────

/// Generalization metric via token replay.
/// Measures: 1 - mean(1/sqrt(visit_count)) over all visited transitions.
/// Transitions visited more → higher generalization.
#[pyfunction]
fn compute_generalization(
    traces: Vec<Vec<String>>,
    transitions: Vec<(String, Vec<usize>, Vec<usize>)>,
    n_places: usize,
    im_places: Vec<usize>,
    fm_places: Vec<usize>,
) -> PyResult<f64> {
    let n_trans = transitions.len();

    let mut label_to_trans: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
    let mut silent_trans: Vec<usize> = Vec::new();
    for (i, (label, _, _)) in transitions.iter().enumerate() {
        if label.is_empty() { silent_trans.push(i); }
        else { label_to_trans.entry(label.as_str()).or_default().push(i); }
    }

    let mut place_producers: Vec<Vec<usize>> = vec![Vec::new(); n_places];
    for &si in &silent_trans {
        for &p in &transitions[si].2 { place_producers[p].push(si); }
    }

    // Count how many times each transition is fired across all traces
    let mut visit_count = vec![0u64; n_trans];
    let mut marking = vec![0i32; n_places];
    let mut visited = vec![false; n_trans];

    for trace in &traces {
        marking.iter_mut().for_each(|x| *x = 0);
        for &p in &im_places { marking[p] = 1; }

        for activity in trace {
            if let Some(trans_ids) = label_to_trans.get(activity.as_str()) {
                let mut chosen = trans_ids[0];
                let mut is_enabled = false;
                for &tid in trans_ids {
                    if transitions[tid].1.iter().all(|&p| marking[p] > 0) {
                        chosen = tid; is_enabled = true; break;
                    }
                }
                if !is_enabled {
                    let mut dc = 0i64;
                    let mut dp = 0i64;
                    for &tid in trans_ids {
                        visited.iter_mut().for_each(|x| *x = false);
                        if try_enable(&transitions[tid].1, &mut marking, &transitions,
                                      &place_producers, &mut dc, &mut dp, &mut visited) {
                            chosen = tid; is_enabled = true; break;
                        }
                    }
                }
                if !is_enabled {
                    for &p in &transitions[chosen].1 {
                        if marking[p] <= 0 { marking[p] += 1; }
                    }
                }
                visit_count[chosen] += 1;
                for &p in &transitions[chosen].1 { marking[p] -= 1; }
                for &p in &transitions[chosen].2 { marking[p] += 1; }
            }
        }
    }

    // Generalization = 1 - mean(1/sqrt(n)) for transitions with n > 0
    let visited_trans: Vec<f64> = visit_count.iter()
        .filter(|&&c| c > 0)
        .map(|&c| 1.0 / (c as f64).sqrt())
        .collect();

    if visited_trans.is_empty() {
        return Ok(0.0);
    }
    let mean_inv_sqrt = visited_trans.iter().sum::<f64>() / visited_trans.len() as f64;
    Ok(1.0 - mean_inv_sqrt)
}

// ── Root cause analysis ─────────────────────────────────────────────

/// Fast case duration computation. Returns a dict mapping case_code → duration_seconds.
#[pyfunction]
fn compute_case_durations<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();

    let n_cases = if n > 0 { cases.iter().copied().max().unwrap_or(0) as usize + 1 } else { 0 };
    let mut case_min = vec![i64::MAX; n_cases];
    let mut case_max = vec![i64::MIN; n_cases];

    for i in 0..n {
        let c = cases[i] as usize;
        let t = ts[i];
        if t < case_min[c] { case_min[c] = t; }
        if t > case_max[c] { case_max[c] = t; }
    }

    let result = PyDict::new(py);
    for c in 0..n_cases {
        if case_min[c] == i64::MAX { continue; }
        let dur = (case_max[c] - case_min[c]) as f64 / 1_000_000_000.0;
        result.set_item(c as i32, dur)?;
    }
    Ok(result)
}

// ── XES parsing ─────────────────────────────────────────────────────

/// Fast XES parser using quick-xml. Returns three parallel lists:
/// (case_ids, activities, timestamps_iso) extracted from the XES XML.
#[pyfunction]
fn parse_xes<'py>(py: Python<'py>, xml_bytes: &[u8]) -> PyResult<Bound<'py, PyDict>> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_reader(xml_bytes);
    reader.config_mut().trim_text(true);

    let mut case_ids: Vec<String> = Vec::new();
    let mut activities: Vec<String> = Vec::new();
    let mut timestamps: Vec<String> = Vec::new();

    let mut current_case_id = String::new();
    let mut in_trace = false;
    let mut in_event = false;
    let mut current_activity = String::new();
    let mut current_timestamp = String::new();

    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let local = name.as_ref();

                if local == b"trace" {
                    in_trace = true;
                    current_case_id.clear();
                } else if local == b"event" && in_trace {
                    in_event = true;
                    current_activity.clear();
                    current_timestamp.clear();
                } else if in_trace && !in_event && local == b"string" {
                    // Trace-level string attribute — look for concept:name
                    let mut key = String::new();
                    let mut val = String::new();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"key" => key = String::from_utf8_lossy(&attr.value).to_string(),
                            b"value" => val = String::from_utf8_lossy(&attr.value).to_string(),
                            _ => {}
                        }
                    }
                    if key == "concept:name" { current_case_id = val; }
                } else if in_event {
                    // Event-level attributes
                    let mut key = String::new();
                    let mut val = String::new();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"key" => key = String::from_utf8_lossy(&attr.value).to_string(),
                            b"value" => val = String::from_utf8_lossy(&attr.value).to_string(),
                            _ => {}
                        }
                    }
                    match local {
                        b"string" if key == "concept:name" => current_activity = val,
                        b"date" if key == "time:timestamp" => current_timestamp = val,
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                let local = name.as_ref();
                if local == b"event" && in_event {
                    in_event = false;
                    if !current_activity.is_empty() && !current_timestamp.is_empty() {
                        case_ids.push(current_case_id.clone());
                        activities.push(current_activity.clone());
                        timestamps.push(current_timestamp.clone());
                    }
                } else if local == b"trace" {
                    in_trace = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    let result = PyDict::new(py);
    result.set_item("case_ids", case_ids)?;
    result.set_item("activities", activities)?;
    result.set_item("timestamps", timestamps)?;
    Ok(result)
}

// ── Sorted transitions (shared precomputation) ─────────────────────

/// Compute the "next event" arrays for every event in the log.
/// This is the shared computation behind all sort+copy+shift patterns.
///
/// Returns a dict with numpy arrays (same length as input, in ORIGINAL
/// row order — not sorted order):
///   sorted_idx:     int32  — the sort permutation (for callers that need sorted iteration)
///   next_act_code:  int32  — activity code of next event in same case (-1 for last)
///   next_ts_ns:     int64  — timestamp of next event in same case (0 for last)
///   duration_ns:    int64  — nanoseconds to next event in same case (0 for last)
///   is_last:        bool   — True for last event in each case
#[pyfunction]
fn compute_transitions<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    use numpy::{PyArray1, PyArrayMethods};

    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();

    let order = build_order(cases, ts);

    // Allocate output arrays in original row order
    let next_act = PyArray1::<i32>::zeros(py, [n], false);
    let next_ts = PyArray1::<i64>::zeros(py, [n], false);
    let duration = PyArray1::<i64>::zeros(py, [n], false);
    let is_last = PyArray1::<bool>::zeros(py, [n], false);
    let sorted_idx = PyArray1::<i32>::zeros(py, [n], false);

    // SAFETY: we exclusively own these arrays, they were just created
    unsafe {
        let na = next_act.as_slice_mut().unwrap();
        let nt = next_ts.as_slice_mut().unwrap();
        let dur = duration.as_slice_mut().unwrap();
        let il = is_last.as_slice_mut().unwrap();
        let si = sorted_idx.as_slice_mut().unwrap();

        // Fill sorted_idx
        for (i, &idx) in order.iter().enumerate() {
            si[i] = idx as i32;
        }

        // Walk sorted order, fill next-event data
        if n > 0 {
            for i in 0..order.len() - 1 {
                let cur = order[i] as usize;
                let nxt = order[i + 1] as usize;

                if cases[cur] == cases[nxt] {
                    // Same case: next event exists
                    na[cur] = acts[nxt];
                    nt[cur] = ts[nxt];
                    dur[cur] = ts[nxt] - ts[cur];
                } else {
                    // Last event in this case
                    na[cur] = -1;
                    nt[cur] = 0;
                    dur[cur] = 0;
                    il[cur] = true;
                }
            }
            // Last event in the entire log
            let last = order[n - 1] as usize;
            na[last] = -1;
            nt[last] = 0;
            dur[last] = 0;
            il[last] = true;
        }
    }

    let result = PyDict::new(py);
    result.set_item("sorted_idx", sorted_idx)?;
    result.set_item("next_act_code", next_act)?;
    result.set_item("next_ts_ns", next_ts)?;
    result.set_item("duration_ns", duration)?;
    result.set_item("is_last", is_last)?;
    Ok(result)
}

// ── Rework detection ────────────────────────────────────────────────

/// Detect rework (repeated activities) and self-loops per case.
/// Returns dict with activities (rework stats), self_loops, overall_rework_rate, etc.
#[pyfunction]
fn compute_rework<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    let order = build_order(cases, ts);

    // Per-activity: cases_with_rework (bitset), total_occ, repetition_sum, repetition_count
    let n_cases = if n > 0 { cases.iter().copied().max().unwrap_or(0) as usize + 1 } else { 0 };
    let mut act_total_occ = vec![0u64; n_acts];
    let mut act_rework_cases = vec![0u64; n_acts]; // count of cases with rework
    let mut act_rep_sum = vec![0u64; n_acts];      // sum of repetition counts for avg
    let mut act_rep_count = vec![0u64; n_acts];    // number of rework cases for avg
    let mut self_loops = vec![0u64; n_acts];
    let mut cases_with_any_rework = 0u64;

    // Per-case activity counts (reused buffer)
    let mut case_act_count = vec![0u32; n_acts];

    if n > 0 {
        let mut prev_case = cases[order[0] as usize];
        let mut prev_act = acts[order[0] as usize] as usize;
        case_act_count[prev_act] = 1;
        act_total_occ[prev_act] += 1;

        let flush_case = |case_act_count: &mut [u32], act_rework_cases: &mut [u64],
                          act_rep_sum: &mut [u64], act_rep_count: &mut [u64],
                          cases_with_any: &mut u64, n_acts: usize| {
            let mut has_rework = false;
            for a in 0..n_acts {
                let cnt = case_act_count[a];
                if cnt > 1 {
                    act_rework_cases[a] += 1;
                    act_rep_sum[a] += cnt as u64;
                    act_rep_count[a] += 1;
                    has_rework = true;
                }
                case_act_count[a] = 0;
            }
            if has_rework { *cases_with_any += 1; }
        };

        for &idx in &order[1..] {
            let idx = idx as usize;
            let cur_case = cases[idx];
            let cur_act = acts[idx] as usize;

            if cur_case != prev_case {
                flush_case(&mut case_act_count, &mut act_rework_cases,
                          &mut act_rep_sum, &mut act_rep_count,
                          &mut cases_with_any_rework, n_acts);
                prev_case = cur_case;
            }

            // Self-loop: consecutive identical activities
            if cur_act == prev_act && cur_case == prev_case {
                self_loops[cur_act] += 1;
            }

            case_act_count[cur_act] += 1;
            act_total_occ[cur_act] += 1;
            prev_act = cur_act;
        }
        // Flush last case
        flush_case(&mut case_act_count, &mut act_rework_cases,
                  &mut act_rep_sum, &mut act_rep_count,
                  &mut cases_with_any_rework, n_acts);
    }

    let total_cases = n_cases as u64;

    // Build output
    let activities = PyList::empty(py);
    let mut act_indices: Vec<usize> = (0..n_acts).filter(|&a| act_total_occ[a] > 0).collect();
    act_indices.sort_by(|&a, &b| act_labels[a].cmp(&act_labels[b]));

    for &a in &act_indices {
        let d = PyDict::new(py);
        let rework_cases = act_rework_cases[a];
        let avg_reps = if act_rep_count[a] > 0 {
            act_rep_sum[a] as f64 / act_rep_count[a] as f64
        } else { 1.0 };
        d.set_item("activity", &act_labels[a])?;
        d.set_item("total_occurrences", act_total_occ[a])?;
        d.set_item("cases_with_rework", rework_cases)?;
        d.set_item("total_cases", total_cases)?;
        d.set_item("rework_rate", (100.0 * rework_cases as f64 / total_cases.max(1) as f64 * 100.0).round() / 100.0)?;
        d.set_item("avg_repetitions", (avg_reps * 1000.0).round() / 1000.0)?;
        activities.append(d)?;
    }

    let self_loops_list = PyList::empty(py);
    let mut sl: Vec<(usize, u64)> = (0..n_acts).filter(|&a| self_loops[a] > 0)
        .map(|a| (a, self_loops[a])).collect();
    sl.sort_by(|a, b| b.1.cmp(&a.1));
    for (a, cnt) in sl {
        let d = PyDict::new(py);
        d.set_item("activity", &act_labels[a])?;
        d.set_item("count", cnt)?;
        self_loops_list.append(d)?;
    }

    let overall = (100.0 * cases_with_any_rework as f64 / total_cases.max(1) as f64 * 100.0).round() / 100.0;

    let result = PyDict::new(py);
    result.set_item("activities", activities)?;
    result.set_item("overall_rework_rate", overall)?;
    result.set_item("cases_with_rework", cases_with_any_rework)?;
    result.set_item("total_cases", total_cases)?;
    result.set_item("self_loops", self_loops_list)?;
    Ok(result)
}

// ── Edge stats ──────────────────────────────────────────────────────

/// Compute stats for a single (source → target) edge transition.
/// Returns frequency, durations, histogram, and eventually-follows fallback.
#[pyfunction]
fn compute_edge_stats<'py>(
    py: Python<'py>,
    case_codes: PyReadonlyArray1<'py, i32>,
    act_codes: PyReadonlyArray1<'py, i32>,
    act_labels: Vec<String>,
    ts_ns: PyReadonlyArray1<'py, i64>,
    source: &str,
    target: &str,
    bins: usize,
) -> PyResult<Bound<'py, PyDict>> {
    let cases = case_codes.as_slice()?;
    let acts = act_codes.as_slice()?;
    let ts = ts_ns.as_slice()?;
    let n = cases.len();
    let n_acts = act_labels.len();

    // Sanitize source/target the same way as Python
    let sanitize = |s: &str| -> String {
        s.replace(' ', "_").replace('/', "_").replace('\\', "_").to_lowercase()
    };
    let src_key = sanitize(source);
    let tgt_key = sanitize(target);

    // Build sanitized label → code mapping
    let san_labels: Vec<String> = act_labels.iter().map(|l| sanitize(l)).collect();
    let src_codes: Vec<usize> = (0..n_acts).filter(|&i| san_labels[i] == src_key).collect();
    let tgt_codes: Vec<usize> = (0..n_acts).filter(|&i| san_labels[i] == tgt_key).collect();

    let order = build_order(cases, ts);
    let total_cases = if n > 0 { cases.iter().copied().max().unwrap_or(0) as usize + 1 } else { 0 };

    // Direct transitions
    let mut durations: Vec<f64> = Vec::new();
    let mut cases_with = vec![false; total_cases];

    if n > 0 {
        let first = order[0] as usize;
        let mut prev_case = cases[first];
        let mut prev_act = acts[first] as usize;
        let mut prev_ts_val = ts[first];

        for &idx in &order[1..] {
            let idx = idx as usize;
            let cur_case = cases[idx];
            let cur_act = acts[idx] as usize;
            let cur_ts = ts[idx];

            if cur_case == prev_case {
                if src_codes.contains(&prev_act) && tgt_codes.contains(&cur_act) {
                    let delta = (cur_ts - prev_ts_val) as f64 / 1_000_000_000.0;
                    if delta >= 0.0 { durations.push(delta); }
                    cases_with[cur_case as usize] = true;
                }
            }
            prev_case = cur_case;
            prev_act = cur_act;
            prev_ts_val = cur_ts;
        }
    }

    // Eventually-follows fallback
    let mut is_ef = false;
    if durations.is_empty() && n > 0 {
        let mut ef_durs: Vec<f64> = Vec::new();
        let mut ef_cases = vec![false; total_cases];
        let mut trace_start = 0usize;
        let mut cur_case = cases[order[0] as usize];

        for i in 0..=order.len() {
            let new_case = if i < order.len() { cases[order[i] as usize] != cur_case } else { true };
            if new_case {
                // Process trace [trace_start..i)
                for si in trace_start..i {
                    let s_idx = order[si] as usize;
                    if !src_codes.contains(&(acts[s_idx] as usize)) { continue; }
                    for ti in (si+1)..i {
                        let t_idx = order[ti] as usize;
                        if tgt_codes.contains(&(acts[t_idx] as usize)) {
                            let delta = (ts[t_idx] - ts[s_idx]) as f64 / 1_000_000_000.0;
                            if delta >= 0.0 { ef_durs.push(delta); }
                            ef_cases[cur_case as usize] = true;
                            break;
                        }
                    }
                }
                if i < order.len() { trace_start = i; cur_case = cases[order[i] as usize]; }
            }
        }
        if !ef_durs.is_empty() {
            durations = ef_durs;
            cases_with = ef_cases;
            is_ef = true;
        }
    }

    let frequency = durations.len();
    let case_count_with = cases_with.iter().filter(|&&x| x).count();
    let case_count_without = total_cases.saturating_sub(case_count_with);
    let coverage = if total_cases > 0 { case_count_with as f64 / total_cases as f64 * 100.0 } else { 0.0 };

    let (avg, med, p95, min_d, max_d) = if !durations.is_empty() {
        durations.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
        let sum: f64 = durations.iter().sum();
        let avg = sum / durations.len() as f64;
        let med = if durations.len() % 2 == 1 { durations[durations.len()/2] }
                  else { (durations[durations.len()/2-1] + durations[durations.len()/2]) / 2.0 };
        let p95_idx = ((durations.len() as f64 * 0.95) as usize).min(durations.len()-1);
        (avg, med, durations[p95_idx], durations[0], *durations.last().unwrap())
    } else { (0.0, 0.0, 0.0, 0.0, 0.0) };

    // Histogram
    let histogram = PyList::empty(py);
    if !durations.is_empty() {
        let p99_idx = ((durations.len() as f64 * 0.99) as usize).min(durations.len()-1);
        let upper = if durations[p99_idx] > min_d { durations[p99_idx] } else { min_d + 1.0 };
        let lower = min_d;
        let width = (upper - lower) / bins as f64;
        let mut counts = vec![0u64; bins];
        for &d in &durations {
            if d > upper { counts[bins-1] += 1; continue; }
            let idx = if width > 0.0 { ((d - lower) / width) as usize } else { 0 };
            counts[idx.min(bins-1)] += 1;
        }
        for (i, &c) in counts.iter().enumerate() {
            let d = PyDict::new(py);
            d.set_item("bin_start", lower + i as f64 * width)?;
            d.set_item("bin_end", lower + (i + 1) as f64 * width)?;
            d.set_item("count", c)?;
            histogram.append(d)?;
        }
    }

    let result = PyDict::new(py);
    result.set_item("source", source)?;
    result.set_item("target", target)?;
    result.set_item("frequency", frequency)?;
    result.set_item("case_count_with", case_count_with)?;
    result.set_item("case_count_without", case_count_without)?;
    result.set_item("coverage_pct", coverage)?;
    result.set_item("avg_duration", avg)?;
    result.set_item("median_duration", med)?;
    result.set_item("p95_duration", p95)?;
    result.set_item("min_duration", min_d)?;
    result.set_item("max_duration", max_d)?;
    result.set_item("histogram", histogram)?;
    result.set_item("is_eventually_follows", is_ef)?;
    Ok(result)
}

// ── module ──────────────────────────────────────────────────────────

#[pymodule]
fn flowminer_accel(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(discover_dfg, m)?)?;
    m.add_function(wrap_pyfunction!(discover_performance_dfg, m)?)?;
    m.add_function(wrap_pyfunction!(analyze_variants, m)?)?;
    m.add_function(wrap_pyfunction!(compute_edge_durations, m)?)?;
    m.add_function(wrap_pyfunction!(compute_efg, m)?)?;
    m.add_function(wrap_pyfunction!(token_replay_fitness, m)?)?;
    m.add_function(wrap_pyfunction!(compute_activity_durations, m)?)?;
    m.add_function(wrap_pyfunction!(compute_precision_etc, m)?)?;
    m.add_function(wrap_pyfunction!(discover_petri_net_heuristics, m)?)?;
    m.add_function(wrap_pyfunction!(compute_temporal_profile, m)?)?;
    m.add_function(wrap_pyfunction!(compute_bottlenecks, m)?)?;
    m.add_function(wrap_pyfunction!(compute_sna, m)?)?;
    m.add_function(wrap_pyfunction!(compute_case_overlap, m)?)?;
    m.add_function(wrap_pyfunction!(compute_generalization, m)?)?;
    m.add_function(wrap_pyfunction!(compute_case_durations, m)?)?;
    m.add_function(wrap_pyfunction!(parse_xes, m)?)?;
    m.add_function(wrap_pyfunction!(compute_transitions, m)?)?;
    m.add_function(wrap_pyfunction!(compute_rework, m)?)?;
    m.add_function(wrap_pyfunction!(compute_edge_stats, m)?)?;
    Ok(())
}
