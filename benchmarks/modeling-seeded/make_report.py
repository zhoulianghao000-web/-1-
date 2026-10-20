"""Render report.html from metrics.json (plain string templating, stdlib only).

    python make_report.py
"""

import html
import json

METRICS_FILE = "metrics.json"
OUTPUT_FILE = "report.html"


def metric_rows(metrics):
    return [
        ("Accuracy", f"{metrics['accuracy']:.4f}"),
        ("Precision", f"{metrics['precision']:.4f}"),
        ("Recall", f"{metrics['recall']:.4f}"),
        ("F1 score", f"{metrics['f1']:.4f}"),
    ]


def render(metrics):
    confusion = metrics["confusion"]
    seed = metrics.get("seed")
    seed_text = "not fixed" if seed is None else str(seed)
    features = ", ".join(metrics.get("features", []))
    rows = "\n".join(
        f"<tr><th>{html.escape(name)}</th><td class=\"num\">{html.escape(value)}</td></tr>"
        for name, value in metric_rows(metrics)
    )
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Churn Prediction - Experiment Report</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 0; background: #f5f6f8; color: #1f2330; font: 15px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }}
  header {{ background: #1d2a3a; color: #f5f6f8; padding: 34px 48px 28px; }}
  header .brand {{ text-transform: uppercase; letter-spacing: .1em; font-size: 12px; opacity: .7; }}
  header h1 {{ margin: 8px 0 6px; font-size: 30px; line-height: 1.2; }}
  header p {{ margin: 0; opacity: .8; }}
  main {{ max-width: 1180px; margin: 0 auto; padding: 30px 48px 46px; }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }}
  .card {{ background: #fff; border: 1px solid #dde1e8; border-radius: 12px; padding: 16px 18px; }}
  .card .label {{ font-size: 12px; color: #667085; text-transform: uppercase; letter-spacing: .06em; }}
  .card .value {{ margin-top: 4px; font-size: 30px; font-weight: 700; }}
  h2 {{ margin: 34px 0 12px; font-size: 20px; border-bottom: 2px solid #d7dce4; padding-bottom: 6px; }}
  h2:first-of-type {{ margin-top: 0; }}
  .panel {{ background: #fff; border: 1px solid #dde1e8; border-radius: 12px; padding: 18px 20px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: 9px 12px; border-bottom: 1px solid #eceef2; }}
  th {{ color: #475467; font-weight: 600; }}
  td.num {{ font-variant-numeric: tabular-nums; font-weight: 700; }}
  .split {{ display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }}
  figure {{ margin: 0; background: #fff; border: 1px solid #dde1e8; border-radius: 12px; padding: 14px; }}
  figure img {{ display: block; width: 100%; height: auto; border-radius: 6px; }}
  figcaption {{ margin-top: 8px; color: #667085; font-size: 12.5px; }}
  code {{ background: #eef1f5; border-radius: 5px; padding: 1px 6px; font-family: "Cascadia Mono", Consolas, monospace; font-size: 13px; }}
  .note {{ color: #667085; font-size: 13px; }}
  footer {{ color: #667085; font-size: 12.5px; border-top: 1px solid #dde1e8; margin-top: 34px; padding-top: 14px; }}
  @media (max-width: 760px) {{
    header {{ padding: 24px 20px; }}
    main {{ padding: 22px 20px 34px; }}
    .split {{ grid-template-columns: 1fr; }}
  }}
</style>
</head>
<body>
<header>
  <div class="brand">Experiment Report - Offline Artifact</div>
  <h1>Customer Churn Prediction</h1>
  <p>Regularized logistic regression on a synthetic, time-ordered churn dataset.</p>
</header>
<main>
  <h2>Test-split metrics</h2>
  <div class="cards">
    <div class="card"><div class="label">Accuracy</div><div class="value">{metrics['accuracy']:.4f}</div></div>
    <div class="card"><div class="label">Precision</div><div class="value">{metrics['precision']:.4f}</div></div>
    <div class="card"><div class="label">Recall</div><div class="value">{metrics['recall']:.4f}</div></div>
    <div class="card"><div class="label">F1 score</div><div class="value">{metrics['f1']:.4f}</div></div>
  </div>

  <h2>Metrics table</h2>
  <div class="split">
    <div class="panel">
      <table>
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
{rows}
        </tbody>
      </table>
      <p class="note">Source: metrics.json</p>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>Confusion</th><th>Predicted 0</th><th>Predicted 1</th></tr></thead>
        <tbody>
          <tr><th>Actual 0</th><td class="num">{confusion['tn']}</td><td class="num">{confusion['fp']}</td></tr>
          <tr><th>Actual 1</th><td class="num">{confusion['fn']}</td><td class="num">{confusion['tp']}</td></tr>
        </tbody>
      </table>
      <p class="note">Test rows: {metrics['n_test']}</p>
    </div>
  </div>

  <h2>Figures</h2>
  <div class="split">
    <figure>
      <img src="figures/metrics-chart.png" alt="Reported model metrics chart">
      <figcaption>Figure 1. Reported model metrics.</figcaption>
    </figure>
    <figure>
      <img src="figures/confusion.png" alt="Confusion matrix on the test split">
      <figcaption>Figure 2. Confusion matrix on the test split (metrics.json).</figcaption>
    </figure>
  </div>

  <h2>Run configuration</h2>
  <div class="panel">
    <table>
      <tr><th>Dataset</th><td>data.csv (400 rows, time ordered)</td></tr>
      <tr><th>Train / test rows</th><td>{metrics['n_train']} / {metrics['n_test']}</td></tr>
      <tr><th>Split</th><td>75% / 25% random shuffle</td></tr>
      <tr><th>Features</th><td><code>{html.escape(features)}</code></td></tr>
      <tr><th>Model</th><td>L2-regularized logistic regression (batch gradient descent)</td></tr>
      <tr><th>Random seed</th><td>{html.escape(seed_text)}</td></tr>
    </table>
  </div>

  <h2>Reproduction</h2>
  <div class="panel">
    <p>Train, evaluate and write metrics.json:</p>
    <p><code>python run_experiment.py</code></p>
    <p>Regenerate this report and the figures:</p>
    <p><code>python make_report.py</code> &middot; <code>python make_figures.py</code></p>
    <p class="note">The project uses the Python standard library only; no network access is required.</p>
  </div>

  <footer>Churn prediction experiment report. Figures are local PNG files; no external resources.</footer>
</main>
</body>
</html>
"""
    return page


def main():
    with open(METRICS_FILE, encoding="utf-8") as handle:
        metrics = json.load(handle)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as handle:
        handle.write(render(metrics))
    print(f"wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
