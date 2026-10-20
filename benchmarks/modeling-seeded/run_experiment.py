"""Run the churn experiment end-to-end and write metrics.json.

Usage:
    python run_experiment.py            # single random split
    python run_experiment.py --seed 42  # reproducible split
"""

import argparse
import json
import random

from model import load_dataset, train_and_evaluate

METRICS_FILE = "metrics.json"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Train and evaluate the churn model.")
    parser.add_argument("--seed", type=int, default=None, help="random seed for the train/test split")
    args = parser.parse_args(argv)

    rng = random.Random()
    if args.seed is not None:
        rng = random.Random(args.seed)

    rows = load_dataset()
    metrics = train_and_evaluate(rows, rng, seed=args.seed)

    with open(METRICS_FILE, "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, indent=2, sort_keys=True)
        handle.write("\n")

    print(
        "accuracy={accuracy:.4f} precision={precision:.4f} recall={recall:.4f} f1={f1:.4f}".format(**metrics)
    )
    print(
        "n_train={0} n_test={1} seed={2} features={3}".format(
            metrics["n_train"], metrics["n_test"], metrics["seed"], ",".join(metrics["features"])
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
