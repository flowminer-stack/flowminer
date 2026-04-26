"""DMN 1.4 XML export for FlowMiner decision rules.

Converts the output of ``mining_engine.discover_decision_rules`` into a
valid DMN 1.4 XML document that can be imported into Camunda Modeler,
Trisotech, or any compliant DMN engine.

Usage::

    from app.services.dmn_export import decision_rules_to_dmn
    xml_str = decision_rules_to_dmn(rules_dict, "My Process")
"""

import re
import xml.etree.ElementTree as ET
from xml.dom import minidom


# ---------------------------------------------------------------------------
# Namespace constants
# ---------------------------------------------------------------------------
DMN_NS = "https://www.omg.org/spec/DMN/20191111/MODEL/"
DMNDI_NS = "https://www.omg.org/spec/DMN/20191111/DMNDI/"
DI_NS = "http://www.omg.org/spec/DMN/20180521/DI/"
DC_NS = "http://www.omg.org/spec/DMN/20180521/DC/"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slugify(text: str) -> str:
    """Convert *text* to a safe XML ID segment (lowercase, alphanumeric + hyphen)."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = text.strip("-")
    return text or "unnamed"


def _parse_rule_text(rule_text: str) -> list[dict]:
    """Parse sklearn ``export_text`` output into a list of flat rule dicts.

    Each dict has the form::

        {
            "conditions": {"feature_name": "FEEL expression", ...},
            "class_": "predecessor activity name",
        }

    sklearn's ``export_text`` produces lines like::

        |--- amount <= 1000.00
        |   |--- class: Auto Approve
        |--- amount >  1000.00
        |   |--- class: Manager Review

    We do a simple depth-first parse: accumulate active conditions at each
    indent level, emit a rule whenever we see a ``class:`` leaf.

    FEEL translation rules applied here:
    - ``<= n``  → ``<= n``
    - ``>  n``  → ``> n``
    - ``<  n``  → ``< n``
    - ``>= n``  → ``>= n``
    - categorical ``= "value"`` → ``"value"``
    - categorical ``!= "value"`` → ``not("value")``
    - anything else → ``-`` (don't care) with a comment stored in the value

    Numeric thresholds use FEEL numeric syntax (no quotes).
    """
    rules: list[dict] = []
    # Stack of (indent_depth, feature, feel_expr)
    condition_stack: list[tuple[int, str, str]] = []

    for raw_line in rule_text.splitlines():
        if not raw_line.strip():
            continue

        # Count indent depth by '|' and spaces before '---'
        depth = raw_line.count("|--- ") + raw_line.count("|  ")
        # A cleaner approach: depth = number of '|' characters before '---'
        prefix = raw_line.split("---")[0] if "---" in raw_line else ""
        depth = prefix.count("|")

        content = raw_line.split("--- ", 1)[-1].strip() if "--- " in raw_line else raw_line.strip()

        # Leaf node: class label
        if content.startswith("class:"):
            class_label = content[len("class:"):].strip()
            # Build conditions dict from stack up to current depth
            conditions: dict[str, str] = {}
            for (d, feat, feel) in condition_stack:
                if d < depth:
                    conditions[feat] = feel
            rules.append({"conditions": conditions, "class_": class_label})
            continue

        # Condition node: "feature <= value" / "feature > value" / etc.
        # Pop stack entries at depth >= current depth (sibling/ancestor replacement)
        condition_stack = [(d, f, e) for (d, f, e) in condition_stack if d < depth]

        feel = _condition_to_feel(content)
        # Extract feature name (everything before the operator)
        feature = _extract_feature(content)
        if feature:
            condition_stack.append((depth, feature, feel))

    return rules


_NUMERIC_OPS = re.compile(
    r"^(.+?)\s*(<=|>=|<|>)\s*([\-\d.]+)\s*$"
)
_CATEGORICAL_EQ = re.compile(r'^(.+?)\s*=\s*"?([^"]+)"?\s*$')
_CATEGORICAL_NEQ = re.compile(r'^(.+?)\s*!=\s*"?([^"]+)"?\s*$')


def _extract_feature(condition: str) -> str | None:
    """Return the feature name from a condition string."""
    for pat in (_NUMERIC_OPS, _CATEGORICAL_EQ, _CATEGORICAL_NEQ):
        m = pat.match(condition)
        if m:
            return m.group(1).strip()
    return None


def _condition_to_feel(condition: str) -> str:
    """Translate a single sklearn condition string to a FEEL entry expression."""
    # Numeric: feature op value
    m = _NUMERIC_OPS.match(condition)
    if m:
        op = m.group(2)
        val = m.group(3)
        # Strip trailing zeros for cleanliness: 1000.00 → 1000
        try:
            num = float(val)
            feel_val = str(int(num)) if num == int(num) else str(num)
        except ValueError:
            feel_val = val
        return f"{op} {feel_val}"

    # Categorical equality: feature = "value"
    m = _CATEGORICAL_EQ.match(condition)
    if m:
        val = m.group(2).strip().strip('"')
        return f'"{val}"'

    # Categorical inequality: feature != "value"
    m = _CATEGORICAL_NEQ.match(condition)
    if m:
        val = m.group(2).strip().strip('"')
        return f'not("{val}")'

    # Fallback — return don't-care but preserve original for comment
    return f"-"  # caller stores original in comment if needed


def _collect_features(parsed_rules: list[dict]) -> list[str]:
    """Return an ordered list of all feature names referenced across all rules."""
    seen: list[str] = []
    seen_set: set[str] = set()
    for rule in parsed_rules:
        for feat in rule["conditions"]:
            if feat not in seen_set:
                seen.append(feat)
                seen_set.add(feat)
    return seen


def _infer_type_ref(feature: str, parsed_rules: list[dict]) -> str:
    """Infer DMN typeRef for a feature by looking at the FEEL expressions used."""
    for rule in parsed_rules:
        feel = rule["conditions"].get(feature, "")
        if feel == "-":
            continue
        # Numeric ops start with an operator followed by a number
        if re.match(r"^(<=|>=|<|>)\s*[\-\d]", feel):
            return "number"
        # Boolean
        if feel in ('"true"', '"false"', "true", "false"):
            return "boolean"
    return "string"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def decision_rules_to_dmn(rules: dict, log_name: str = "Process") -> str:
    """Convert ``discover_decision_rules`` output to a DMN 1.4 XML string.

    Parameters
    ----------
    rules:
        The dict returned by ``mining_engine.discover_decision_rules``.
        Expected shape::

            {
              "rules": [
                {
                  "activity": str,
                  "predecessors": [str, ...],
                  "rule_text": str,          # sklearn export_text
                  "training_accuracy": float,
                  "feature_importances": [...],
                  "sample_count": int,
                }
              ],
              "activity_count": int,
            }

    log_name:
        Human-readable name of the event log, used for the DMN ``name``
        attribute and filename suggestions.

    Returns
    -------
    str
        A UTF-8 XML string beginning with ``<?xml version='1.0'
        encoding='UTF-8'?>``.  No BOM is included.
    """
    slug = _slugify(log_name)

    # Register namespaces so ET uses the right prefixes
    ET.register_namespace("", DMN_NS)
    ET.register_namespace("dmndi", DMNDI_NS)
    ET.register_namespace("di", DI_NS)
    ET.register_namespace("dc", DC_NS)

    definitions = ET.Element(
        f"{{{DMN_NS}}}definitions",
        attrib={
            "xmlns:dmndi": DMNDI_NS,
            "xmlns:di": DI_NS,
            "xmlns:dc": DC_NS,
            "id": f"flowminer_dmn_{slug}",
            "name": f"{log_name} Decisions",
            "namespace": f"https://flowminer.io/dmn/{slug}",
        },
    )

    rule_list: list[dict] = rules.get("rules", [])

    if not rule_list:
        # No rules — emit an empty definitions with an explanatory comment
        comment = ET.Comment(
            " FlowMiner: no decision rules were discovered for this event log. "
            "Possible reasons: fewer than 20 cases per branching activity, "
            "or no usable case attributes. "
        )
        definitions.append(comment)
    else:
        for idx, entry in enumerate(rule_list):
            _append_decision(definitions, entry, idx)

    # Serialize to bytes then decode
    raw = ET.tostring(definitions, encoding="unicode", xml_declaration=False)

    # Pretty-print via minidom
    dom = minidom.parseString(f'<?xml version="1.0" encoding="UTF-8"?>{raw}')
    pretty = dom.toprettyxml(indent="  ", encoding=None)

    # minidom adds its own <?xml?> declaration; strip any duplicates
    lines = pretty.splitlines()
    # Remove blank lines minidom inserts at the top
    cleaned_lines = [l for l in lines if l.strip()]
    result = "\n".join(cleaned_lines)

    # Ensure single XML declaration at top
    decl = '<?xml version="1.0" encoding="UTF-8"?>'
    if result.startswith("<?xml"):
        result = decl + "\n" + "\n".join(result.split("\n")[1:])
    else:
        result = decl + "\n" + result

    return result


def _append_decision(
    parent: ET.Element,
    entry: dict,
    idx: int,
) -> None:
    """Build a ``<decision>`` element for one activity and append it to *parent*."""
    activity = str(entry.get("activity", f"activity_{idx}"))
    activity_slug = _slugify(activity)
    rule_text: str = entry.get("rule_text", "")
    training_accuracy: float = entry.get("training_accuracy", 0.0)
    predecessors: list[str] = entry.get("predecessors", [])
    sample_count: int = entry.get("sample_count", 0)

    parsed_rules = _parse_rule_text(rule_text) if rule_text else []
    features = _collect_features(parsed_rules)

    decision_id = f"decision_{activity_slug}_{idx}"
    dt_id = f"dt_{activity_slug}_{idx}"

    decision = ET.SubElement(
        parent,
        f"{{{DMN_NS}}}decision",
        attrib={
            "id": decision_id,
            "name": f"Predecessor of {activity}",
        },
    )

    # Annotation comment with mining metadata
    annotation = ET.Comment(
        f" FlowMiner: activity='{activity}' | "
        f"predecessors={predecessors} | "
        f"training_accuracy={training_accuracy:.3f} | "
        f"sample_count={sample_count} "
    )
    decision.append(annotation)

    dt = ET.SubElement(
        decision,
        f"{{{DMN_NS}}}decisionTable",
        attrib={
            "id": dt_id,
            "hitPolicy": "FIRST",
        },
    )

    # Build input columns
    for fi, feat in enumerate(features):
        type_ref = _infer_type_ref(feat, parsed_rules)
        inp = ET.SubElement(
            dt,
            f"{{{DMN_NS}}}input",
            attrib={"id": f"input_{activity_slug}_{idx}_{fi}", "label": feat},
        )
        inp_expr = ET.SubElement(
            inp,
            f"{{{DMN_NS}}}inputExpression",
            attrib={"typeRef": type_ref},
        )
        txt = ET.SubElement(inp_expr, f"{{{DMN_NS}}}text")
        txt.text = feat

    # Output column — the predecessor activity
    ET.SubElement(
        dt,
        f"{{{DMN_NS}}}output",
        attrib={
            "id": f"output_{activity_slug}_{idx}",
            "label": "Predecessor Activity",
            "name": "predecessor_activity",
            "typeRef": "string",
        },
    )

    # Build one rule per parsed leaf
    for ri, prule in enumerate(parsed_rules):
        rule_el = ET.SubElement(
            dt,
            f"{{{DMN_NS}}}rule",
            attrib={"id": f"rule_{activity_slug}_{idx}_{ri}"},
        )

        # One inputEntry per feature column (in order)
        for fi, feat in enumerate(features):
            feel_expr = prule["conditions"].get(feat, "-")
            ie = ET.SubElement(
                rule_el,
                f"{{{DMN_NS}}}inputEntry",
                attrib={"id": f"ie_{activity_slug}_{idx}_{ri}_{fi}"},
            )
            ie_txt = ET.SubElement(ie, f"{{{DMN_NS}}}text")
            ie_txt.text = feel_expr

        # outputEntry — predecessor class label
        oe = ET.SubElement(
            rule_el,
            f"{{{DMN_NS}}}outputEntry",
            attrib={"id": f"oe_{activity_slug}_{idx}_{ri}"},
        )
        oe_txt = ET.SubElement(oe, f"{{{DMN_NS}}}text")
        # Quote as FEEL string literal
        class_label = prule.get("class_", "")
        oe_txt.text = f'"{class_label}"'
