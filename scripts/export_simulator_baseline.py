#!/usr/bin/env python3
"""
把大数模拟器导出的 xlsx 转成 JSON，供本地对表脚本复用。

用法：
  python3 scripts/export_simulator_baseline.py \
    "/path/to/大数评分表.xlsx" \
    "/tmp/simulator_baseline.json"
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "缺少 openpyxl，请先执行 `python3 -m pip install openpyxl`"
    ) from exc


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "Usage: python3 scripts/export_simulator_baseline.py <input.xlsx> <output.json>"
        )
        return 1

    source = Path(sys.argv[1]).expanduser()
    target = Path(sys.argv[2]).expanduser()

    wb = load_workbook(source, read_only=False, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) <= 1:
        raise SystemExit("导出表没有数据行")

    headers = [str(item) if item is not None else "" for item in rows[0]]
    result = []
    for row in rows[1:]:
        if not row or not row[0]:
            continue
        raw = dict(zip(headers, row))
        code = str(raw["代码"]).split(".")[0]
        result.append(
            {
                "code": code,
                "name": raw["名称"],
                "sector": raw["行业"],
                "industry": raw["细分"],
                "score": raw["分数"],
                "pb": raw["pb"],
                "pe": raw["peTtm"],
                "gain1y": raw["1年涨幅%"],
                "price": raw["现价"],
                "low1y": raw["1年低价"],
                "mineScore": raw["扫雷"],
                "debtRatio": raw["资产负债率"],
                "debtMedian": raw["细分行业资产负债率中位数"],
                "dividendYield": raw["股息率"],
                "pledgeRatio": raw["质押率"],
                "goodwillRatio": raw["商誉占净资产的百分比"],
                "pbFloor": raw["个股历史PB低点"],
                "industryPbFloor": raw["行业统计PB底"],
                "marketCapYi": raw["总市值（亿）"],
            }
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"已导出 {len(result)} 条基线数据到 {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
