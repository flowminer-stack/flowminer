# BPI Challenge 2019 (real SAP P2P event log)

Real procure-to-pay data from a Dutch coatings multinational (Akzo Nobel):
**1,595,923 events / 251,734 cases / 42 activities**, licensed **CC BY 4.0**
(free, no login). The closest free proxy to a real EKKO/EKPO/EKBE extract.

The `.xes` is **not committed** (728 MB; see `.gitignore`). Fetch it locally:

```bash
python backend/scripts/fetch_bpic.py
# or, with an explicit mirror:
BPIC2019_XES_URL="https://…/BPI_Challenge_2019.xes.gz" python backend/scripts/fetch_bpic.py
```

Once `BPI_Challenge_2019.xes` is here, the integration test
(`tests/connectors/test_log_join_bpic.py::test_bpic2019_real_log_and_join`)
runs: it loads the log with pm4py, validates it as a mineable event log, then
reconstructs a header (Purchasing Document) + line table and joins them through
`build_event_log` — exercising the consolidation engine on real SAP-shaped data.
When the file is absent the test skips, so CI stays green.

Dataset page: https://data.4tu.nl/articles/dataset/BPI_Challenge_2019/12715853
