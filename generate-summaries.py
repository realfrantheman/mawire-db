#!/usr/bin/env python3
"""Add a journalist-style `summary` field to every deal in deals.json."""

import json
import re
import sys


TICKER_RE = re.compile(r'\s*\([^)]+\)')
# Split on sentence boundary: period followed by space + capital letter (avoids "$3.8")
SENTENCE_SPLIT_RE = re.compile(r'(?<=[a-z])\.\s+(?=[A-Z])')


def clean_name(name):
    if not name:
        return ""
    return TICKER_RE.sub("", name).strip()


def generate_summary(deal):
    deal_type = deal.get("dealType") or "Transaction"
    acquirer_raw = deal.get("acquirer") or ""
    target_raw = deal.get("target") or ""
    deal_value = deal.get("dealValue") or "Undisclosed"
    date = deal.get("date") or ""
    body = deal.get("body") or ""
    source = deal.get("source") or ""

    # For manually curated deals (non-SEC) use first sentence of body
    if source != "SEC Filing" and body:
        parts = SENTENCE_SPLIT_RE.split(body)
        first = parts[0].rstrip(".")
        if len(first) > 30:
            return first + "."

    acquirer = clean_name(acquirer_raw)
    target = clean_name(target_raw)

    placeholder_acquirer = acquirer_raw in ("Disclosed in filing", "")
    placeholder_target = target_raw in ("Public company target (see filing)", "")

    has_acquirer = bool(acquirer) and not placeholder_acquirer
    has_target = bool(target) and not placeholder_target
    has_value = deal_value not in ("Undisclosed", "$0", "")

    value_str = f" valued at {deal_value}" if has_value else ""

    if deal_type == "Merger":
        if has_acquirer and has_target:
            return (
                f"{acquirer} agreed to acquire {target} in a transaction{value_str}. "
                f"The merger requires shareholder approval following an SEC proxy filing on {date}."
            )
        elif has_target:
            value_clause = f" in a {deal_value} deal" if has_value else ""
            return (
                f"{target} shareholders are voting on a proposed merger{value_clause}. "
                f"The definitive proxy statement was filed with the SEC on {date}."
            )
        elif has_acquirer:
            return (
                f"{acquirer} filed a merger proxy with the SEC on {date}. "
                f"The transaction{value_str} is pending shareholder approval."
            )

    elif deal_type == "Acquisition":
        if has_acquirer and has_target:
            return (
                f"{acquirer} launched a tender offer to acquire {target}{value_str}. "
                f"The formal SC TO-T filing was submitted to the SEC on {date}."
            )
        elif has_acquirer:
            return (
                f"{acquirer} launched a formal tender offer to acquire a publicly traded company. "
                f"The SC TO-T filing was submitted to the SEC on {date}."
            )
        elif has_target:
            return (
                f"A formal tender offer has been launched to acquire {target}{value_str}. "
                f"The offer was filed with the SEC on {date}."
            )

    elif deal_type in ("Funding Round", "Strategic Investment"):
        company = target or acquirer
        return (
            f"{company} raised {deal_value} in a {deal_type.lower()} "
            f"announced on {date}."
        )

    elif deal_type == "Divestiture":
        parties = f"{acquirer} divested {target}" if (has_acquirer and has_target) else f"A divestiture{value_str} was completed"
        return f"{parties}{value_str}. The transaction closed on {date}."

    # Generic fallback: first sentence of body
    if body:
        parts = SENTENCE_SPLIT_RE.split(body)
        first = parts[0].rstrip(".")
        if len(first) > 30:
            return first + "."

    return f"A {deal_type.lower()} transaction{value_str} was announced on {date}."


def main():
    print("Loading deals.json …", flush=True)
    with open("deals.json", encoding="utf-8") as f:
        deals = json.load(f)

    print(f"Generating summaries for {len(deals)} deals …", flush=True)
    for deal in deals:
        deal["summary"] = generate_summary(deal)

    print("Writing deals.json …", flush=True)
    with open("deals.json", "w", encoding="utf-8") as f:
        json.dump(deals, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Done. {len(deals)} deals updated.", flush=True)


if __name__ == "__main__":
    main()
