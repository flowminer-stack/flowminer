"""
SAP connector: extract event data from SAP ERP via RFC or OData.

Config keys:
    - mode: str — "odata", "rfc", or "change_documents"
    - base_url: str — OData endpoint URL (for odata mode)
    - username: str
    - password: str
    - entity_set: str — OData entity set (e.g., "PurchaseOrderSet")
    - query_filter: str — (optional) OData $filter expression
    - limit: int — Max records (default: 10000)

    For RFC mode:
    - ashost: str — SAP application server host
    - sysnr: str — System number
    - client: str — SAP client number
    - function_module: str — RFC function module to call

    Change-document mode (CDHDR/CDPOS):
    - mode: "change_documents"  OR  use_change_documents: true
    - cdhdr_entity_set: str — OData entity set exposing CDHDR
      (default: "CDHDRSet")
    - cdpos_entity_set: str — (optional) OData entity set exposing CDPOS
      (default: "CDPOSSet"); when present the field-level changes are
      joined onto the header rows via the change number (CHANGENR).
    - object_class: str — (optional) restrict to a single OBJECTCLAS
      (e.g., "EINKBELEG" for purchase orders, "VERKBELEG" for sales orders)
    SAP change documents are the canonical source of event timestamps —
    every business-object edit writes a CDHDR row (who/when/transaction)
    and one or more CDPOS rows (which field changed, old → new value), so
    they reconstruct a process far better than a single entity snapshot.
"""

import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector

logger = logging.getLogger(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")


class SAPConnector(BaseConnector):

    async def test_connection(self, config: dict) -> dict:
        mode = config.get("mode", "odata")
        if mode == "odata":
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        config["base_url"],
                        auth=(config["username"], config["password"]),
                        headers={"Accept": "application/json"},
                        params={"$top": 1},
                    )
                    resp.raise_for_status()
                return {"success": True, "message": "Connected to SAP OData"}
            except Exception as e:
                return {"success": False, "message": str(e)}
        elif mode == "rfc":
            try:
                import pyrfc
                conn = pyrfc.Connection(
                    ashost=config["ashost"],
                    sysnr=config["sysnr"],
                    client=config["client"],
                    user=config["username"],
                    passwd=config["password"],
                )
                conn.ping()
                conn.close()
                return {"success": True, "message": "Connected to SAP via RFC"}
            except ImportError:
                return {"success": False, "message": "pyrfc not installed. Install SAP NW RFC SDK + pyrfc."}
            except Exception as e:
                return {"success": False, "message": str(e)}
        return {"success": False, "message": f"Unknown SAP mode: {mode}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        mode = config.get("mode", "odata")
        # Change documents (CDHDR/CDPOS) can be requested either by selecting
        # the dedicated mode or by toggling the additive flag on top of the
        # existing odata config — the single-entity path is unaffected.
        if mode == "change_documents" or config.get("use_change_documents"):
            return await self._fetch_change_documents(config)
        if mode == "odata":
            return await self._fetch_odata(config)
        elif mode == "rfc":
            return self._fetch_rfc(config)
        raise ValueError(f"Unknown SAP mode: {mode}")

    async def _fetch_odata(self, config: dict) -> str:
        entity_set = config.get("entity_set", "")
        if not entity_set:
            raise ValueError("No entity_set specified")

        url = f"{config['base_url']}/{entity_set}"
        params = {
            "$format": "json",
            "$top": config.get("limit", 10000),
        }
        if config.get("query_filter"):
            params["$filter"] = config["query_filter"]

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(
                url,
                auth=(config["username"], config["password"]),
                params=params,
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()

        data = resp.json()
        results = data.get("d", {}).get("results", data.get("value", []))
        df = pd.DataFrame(results)

        # Remove OData metadata columns
        for col in ["__metadata", "@odata.etag"]:
            if col in df.columns:
                df = df.drop(columns=[col])

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"sap_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"SAP OData: fetched {len(df)} rows → {file_path}")
        return file_path

    async def _fetch_change_documents(self, config: dict) -> str:
        """Extract an event log from SAP change documents (CDHDR/CDPOS).

        Change documents are the authoritative record of *when* and *by whom*
        a business object was edited, which makes them the natural source of
        process-mining timestamps:

          * CDHDR (header) — one row per change event: OBJECTCLAS, OBJECTID,
            CHANGENR, USERNAME, UDATE (date), UTIME (time), TCODE, CHANGE_IND.
          * CDPOS (items)  — one row per changed field: CHANGENR, TABNAME,
            FNAME, CHNGIND, VALUE_OLD, VALUE_NEW.

        This implementation queries the *filtered* CDHDR set over OData and,
        when a CDPOS entity set is configured, fetches only the field-level
        item rows whose change number (CHANGENR) belongs to that header set
        (server-side ``$filter`` on CHANGENR, paged in batches), then
        inner-joins them so only in-scope items become events. It then derives
        event-log columns:

          * ``case_id``    ← OBJECTID  (the business object instance)
          * ``activity``   ← changed field/table or change indicator
          * ``timestamp``  ← UDATE + UTIME combined into an ISO timestamp
          * ``resource``   ← USERNAME

        The original single-entity OData/RFC path is untouched; this is opt-in
        via ``mode="change_documents"`` or ``use_change_documents: true``.
        """
        base_url = config["base_url"]
        cdhdr_set = config.get("cdhdr_entity_set", "CDHDRSet")
        cdpos_set = config.get("cdpos_entity_set", "CDPOSSet")
        limit = config.get("limit", 10000)

        filters: list[str] = []
        if config.get("object_class"):
            filters.append(f"OBJECTCLAS eq '{config['object_class']}'")
        if config.get("query_filter"):
            filters.append(config["query_filter"])

        hdr_params = {"$format": "json", "$top": limit}
        if filters:
            hdr_params["$filter"] = " and ".join(filters)

        async with httpx.AsyncClient(timeout=120) as client:
            hdr_resp = await client.get(
                f"{base_url}/{cdhdr_set}",
                auth=(config["username"], config["password"]),
                params=hdr_params,
                headers={"Accept": "application/json"},
            )
            hdr_resp.raise_for_status()
            hdr_payload = hdr_resp.json()
            hdr_rows = hdr_payload.get("d", {}).get(
                "results", hdr_payload.get("value", [])
            )

            # Scope CDPOS to the *filtered* CDHDR set. The header rows already
            # honour object_class/query_filter and the global $top, so the only
            # in-scope change numbers are exactly those returned above. Fetching
            # CDPOS with its own unfiltered $top would (a) pull items for
            # out-of-scope headers — surviving a left-join as NaN events — and
            # (b) silently truncate in-scope items past the global limit. We
            # therefore collect the in-scope CHANGENR set and fetch CDPOS
            # filtered by it (paged in batches when the set is large), then
            # inner-join so only in-scope items become events.
            pos_rows: list[dict] = []
            change_nrs = sorted(
                {
                    str(r["CHANGENR"])
                    for r in hdr_rows
                    if r.get("CHANGENR") is not None
                }
            )
            if cdpos_set and change_nrs:
                try:
                    # Batch the $filter so the OR-expression stays within
                    # typical OData URL/expression limits.
                    batch_size = config.get("cdpos_filter_batch_size", 50)
                    for start in range(0, len(change_nrs), batch_size):
                        batch = change_nrs[start : start + batch_size]
                        clause = " or ".join(
                            f"CHANGENR eq '{nr}'" for nr in batch
                        )
                        pos_resp = await client.get(
                            f"{base_url}/{cdpos_set}",
                            auth=(config["username"], config["password"]),
                            params={
                                "$format": "json",
                                "$filter": clause,
                                "$top": limit,
                            },
                            headers={"Accept": "application/json"},
                        )
                        pos_resp.raise_for_status()
                        pos_payload = pos_resp.json()
                        pos_rows.extend(
                            pos_payload.get("d", {}).get(
                                "results", pos_payload.get("value", [])
                            )
                        )
                except Exception as e:
                    # CDPOS is optional — fall back to header-only events.
                    logger.warning(f"SAP CDPOS fetch failed, header-only: {e}")
                    pos_rows = []

        hdr_df = pd.DataFrame(hdr_rows)
        for col in ["__metadata", "@odata.etag"]:
            if col in hdr_df.columns:
                hdr_df = hdr_df.drop(columns=[col])

        if pos_rows:
            pos_df = pd.DataFrame(pos_rows)
            for col in ["__metadata", "@odata.etag"]:
                if col in pos_df.columns:
                    pos_df = pos_df.drop(columns=[col])
            if "CHANGENR" in hdr_df.columns and "CHANGENR" in pos_df.columns:
                # Normalise the join key on both sides — the CDPOS set was
                # filtered server-side by string CHANGENR, but pandas may infer
                # numeric dtypes from JSON, which would break the join.
                pos_df["CHANGENR"] = pos_df["CHANGENR"].astype(str)
                hdr_df["CHANGENR"] = hdr_df["CHANGENR"].astype(str)
                # Inner-join so only items belonging to the filtered header set
                # become events: no NaN OBJECTID/USERNAME/timestamp rows from
                # out-of-scope CDPOS, and no in-scope headers dropped.
                df = pos_df.merge(
                    hdr_df, on="CHANGENR", how="inner", suffixes=("", "_hdr")
                )
            else:
                df = hdr_df
        else:
            df = hdr_df

        # Derive a combined ISO timestamp from the SAP date/time fields when
        # both are present (UDATE = YYYYMMDD, UTIME = HHMMSS).
        if "UDATE" in df.columns:
            udate = df["UDATE"].astype(str).str.replace("-", "", regex=False)
            utime = (
                df["UTIME"].astype(str).str.replace(":", "", regex=False)
                if "UTIME" in df.columns
                else "000000"
            )
            df["event_timestamp"] = pd.to_datetime(
                udate + utime, format="%Y%m%d%H%M%S", errors="coerce"
            )

        # Derive the activity label: prefer the changed table/field, else the
        # header change indicator (I=insert, U=update, D=delete).
        if "TABNAME" in df.columns or "FNAME" in df.columns:
            tab = df.get("TABNAME", "").astype(str) if "TABNAME" in df.columns else ""
            fld = df.get("FNAME", "").astype(str) if "FNAME" in df.columns else ""
            if "TABNAME" in df.columns and "FNAME" in df.columns:
                df["activity"] = (tab + "." + fld).str.strip(".")
            elif "TABNAME" in df.columns:
                df["activity"] = tab
            else:
                df["activity"] = fld
        elif "CHANGE_IND" in df.columns:
            df["activity"] = df["CHANGE_IND"].astype(str)

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"sap_cdoc_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"SAP change documents: fetched {len(df)} rows → {file_path}")
        return file_path

    def _fetch_rfc(self, config: dict) -> str:
        import pyrfc

        conn = pyrfc.Connection(
            ashost=config["ashost"],
            sysnr=config["sysnr"],
            client=config["client"],
            user=config["username"],
            passwd=config["password"],
        )

        fm = config.get("function_module", "")
        if not fm:
            raise ValueError("No function_module specified for RFC mode")

        result = conn.call(fm)
        conn.close()

        # Attempt to find a table-like structure in the result
        records = []
        for key, val in result.items():
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                records = val
                break

        df = pd.DataFrame(records)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, f"sap_rfc_{uuid.uuid4().hex[:8]}.parquet")
        df.to_parquet(file_path, index=False)
        logger.info(f"SAP RFC: fetched {len(df)} rows → {file_path}")
        return file_path

    async def get_schema(self, config: dict) -> dict:
        mode = config.get("mode", "odata")
        if mode == "odata":
            # Fetch metadata from OData $metadata endpoint
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        f"{config['base_url']}/$metadata",
                        auth=(config["username"], config["password"]),
                    )
                    return {"tables": [], "raw_metadata": resp.text[:5000]}
            except Exception:
                pass
        return {"tables": []}

    def get_default_column_mapping(self, config: dict) -> dict | None:
        if config.get("mode") == "change_documents" or config.get("use_change_documents"):
            # Mapping aligned with the columns derived in
            # _fetch_change_documents (OBJECTID = case, activity/timestamp
            # derived, USERNAME = resource).
            return {
                "case_id_column": "OBJECTID",
                "activity_column": "activity",
                "timestamp_column": "event_timestamp",
                "resource_column": "USERNAME",
            }
        entity = config.get("entity_set", "").lower()
        if "purchaseorder" in entity:
            return {
                "case_id_column": "PurchaseOrder",
                "activity_column": "Status",
                "timestamp_column": "CreatedDate",
            }
        if "salesorder" in entity:
            return {
                "case_id_column": "SalesOrder",
                "activity_column": "Status",
                "timestamp_column": "CreatedDate",
            }
        return None
