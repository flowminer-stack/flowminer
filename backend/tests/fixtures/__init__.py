"""Test data fixtures and synthetic source-system generators.

These build the relational, multi-table inputs the connector + log-builder
tests consume — most importantly the P2P (purchase-to-pay) generator that emits
header/line/history tables sharing an ``order_id`` key, mirroring the
EKKO/EKPO/EKBE shape the ``sap_p2p`` recipe joins.
"""
