"""Churn prediction pipeline: regularized logistic regression on a small
synthetic dataset.

Pure Python standard library only (no third-party dependencies), so the
experiment runs offline:

    python run_experiment.py --seed 42
"""

import csv
import math

DATA_FILE = "data.csv"
TARGET = "label"

# Numeric columns available in data.csv (row_id keeps each record identifiable).
FEATURE_POOL = ["row_id", "f1", "f2", "f3", "f4", "f5"]
FEATURE_COUNT = 4
TEST_FRACTION = 0.25
LEARNING_RATE = 0.6
EPOCHS = 500
L2 = 0.001


def load_dataset(path=DATA_FILE):
    """Read data.csv and return one dict per row (features + label)."""
    rows = []
    with open(path, newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            row = {name: float(record[name]) for name in FEATURE_POOL if name in record}
            row[TARGET] = float(record[TARGET])
            rows.append(row)
    return rows


def _mean(values):
    return sum(values) / len(values)


def _std(values):
    mean = _mean(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return math.sqrt(variance) or 1.0


def _corr(xs, ys):
    mean_x, mean_y = _mean(xs), _mean(ys)
    numerator = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    denominator = math.sqrt(
        sum((x - mean_x) ** 2 for x in xs) * sum((y - mean_y) ** 2 for y in ys)
    ) or 1.0
    return numerator / denominator


def select_features(rows, count=FEATURE_COUNT):
    """Rank the feature pool by |correlation| with the target and keep the top k."""
    labels = [row[TARGET] for row in rows]
    ranked = []
    for name in FEATURE_POOL:
        ranked.append((abs(_corr([row[name] for row in rows], labels)), name))
    ranked.sort(reverse=True)
    return [name for _score, name in ranked[:count]]


def fit_scaler(rows, features):
    """Compute per-feature mean/std used to standardise the inputs."""
    stats = {}
    for name in features:
        values = [row[name] for row in rows]
        stats[name] = (_mean(values), _std(values))
    return stats


def scale_rows(rows, features, stats):
    """Standardise every row with the fitted (mean, std) pairs."""
    scaled = []
    for row in rows:
        item = {name: (row[name] - stats[name][0]) / stats[name][1] for name in features}
        item[TARGET] = row[TARGET]
        scaled.append(item)
    return scaled


def split_rows(rows, rng, test_fraction=TEST_FRACTION):
    """Shuffle the rows and cut them into train/test partitions."""
    shuffled = list(rows)
    rng.shuffle(shuffled)
    cut = int(len(shuffled) * (1.0 - test_fraction))
    return shuffled[:cut], shuffled[cut:]


def _sigmoid(z):
    if z < -35.0:
        return 0.0
    if z > 35.0:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def train_logistic(rows, features):
    """Fit L2-regularized logistic regression with batch gradient descent."""
    weights = {name: 0.0 for name in features}
    bias = 0.0
    for _epoch in range(EPOCHS):
        gradient = {name: 0.0 for name in features}
        gradient_bias = 0.0
        for row in rows:
            z = bias + sum(weights[name] * row[name] for name in features)
            error = _sigmoid(z) - row[TARGET]
            for name in features:
                gradient[name] += error * row[name]
            gradient_bias += error
        count = len(rows)
        for name in features:
            weights[name] -= LEARNING_RATE * (gradient[name] / count + L2 * weights[name])
        bias -= LEARNING_RATE * gradient_bias / count
    return weights, bias


def predict(row, weights, bias, features):
    z = bias + sum(weights[name] * row[name] for name in features)
    return 1 if _sigmoid(z) >= 0.5 else 0


def evaluate(rows, weights, bias, features):
    """Return accuracy / precision / recall / F1 and the confusion matrix."""
    tn = fp = fn = tp = 0
    for row in rows:
        prediction = predict(row, weights, bias, features)
        actual = int(row[TARGET])
        if prediction == 1 and actual == 1:
            tp += 1
        elif prediction == 1 and actual == 0:
            fp += 1
        elif prediction == 0 and actual == 1:
            fn += 1
        else:
            tn += 1
    total = tp + fp + fn + tn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "accuracy": round(accuracy, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "confusion": {"tn": tn, "fp": fp, "fn": fn, "tp": tp},
    }


def train_and_evaluate(rows, rng, seed=None):
    """Select features, standardise, split, train and evaluate in one call."""
    features = select_features(rows, FEATURE_COUNT)
    stats = fit_scaler(rows, features)
    scaled = scale_rows(rows, features, stats)
    train_rows, test_rows = split_rows(scaled, rng, TEST_FRACTION)
    weights, bias = train_logistic(train_rows, features)
    metrics = evaluate(test_rows, weights, bias, features)
    metrics.update({
        "features": features,
        "n_train": len(train_rows),
        "n_test": len(test_rows),
        "seed": seed,
    })
    return metrics
