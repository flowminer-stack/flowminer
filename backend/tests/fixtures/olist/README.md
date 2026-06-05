# Olist e-commerce dataset (real-world multi-table join fixture)

A real Brazilian e-commerce dataset whose relational tables share `order_id`
with several lifecycle timestamps — an order-to-cash process that exercises the
log-join / consolidation engine on **real** data (not synthetic).

The connector tests in `tests/connectors/test_log_join_olist.py` use three files:

| File | Grain | Used for |
|------|-------|----------|
| `olist_orders_dataset.csv` | 1 row / order (header) | 4 lifecycle timestamps → activities |
| `olist_order_payments_dataset.csv` | N rows / order | aggregated → joined (one-to-one) |
| `olist_order_items_dataset.csv` | N rows / order | the many-to-many **reject** test |

## Licence

Kaggle dataset `olistbr/brazilian-ecommerce`, licensed **CC BY-NC-SA 4.0** —
internal development/testing only. The CSVs are **not committed** (see
`.gitignore` here); fetch them locally.

## How to get the data

```bash
# Option A — Kaggle CLI (needs ~/.kaggle/kaggle.json credentials)
python backend/scripts/fetch_olist.py

# Option B — point at any mirror zip
OLIST_ZIP_URL="https://…/brazilian-ecommerce.zip" python backend/scripts/fetch_olist.py
```

Files land in this directory. Once present, the Olist tests run automatically;
when absent they **skip** (so CI without the data stays green).
