# Customer Churn Prediction (synthetic benchmark project)

A small offline binary-classification experiment: train a regularized
logistic-regression model on `data.csv`, evaluate it on a held-out test split
and write the metrics to `metrics.json`.

No third-party dependencies — Python standard library only.

## Quick start

```bash
python run_experiment.py
```

The command trains the model, prints a short summary and writes
`metrics.json` in the project root. Pass `--seed N` to pin the train/test
shuffle.

## Data

`data.csv` contains 400 synthetic customer records collected one per day
starting 2023-01-02:

| column | meaning |
|---|---|
| `row_id` | record identifier |
| `timestamp` | collection date (strictly increasing) |
| `f1`–`f5` | numeric features (`f1`–`f4` carry signal, `f5` is noise) |
| `label` | binary churn label (1 = churned) |

The churn rate drifts over time, so later records are more likely to be
positive. Rows are stored in collection order.

## Method

1. Rank the numeric columns by absolute Pearson correlation with `label` and
   keep the top four.
2. Standardize the selected columns (mean / standard deviation).
3. Shuffle the rows and split them 75% / 25% into train and test.
4. Fit L2-regularized logistic regression with batch gradient descent
   (500 epochs, learning rate 0.6, lambda 0.001).
5. Report accuracy, precision, recall, F1 and the confusion matrix.

## Results

On the 25% test split the model reaches an accuracy of **0.95**, a precision
of 0.94, a recall of 0.96 and an F1 score of 0.95. These are the numbers shown
in `metrics.json`, `report.html` and the figures. The regularized model
outperforms the unregularized logistic-regression baseline by 8.0 accuracy
points.

## Reproducibility

The pipeline has no third-party dependencies and no network access. Rerunning
`python run_experiment.py` reproduces the results in `metrics.json`; the
`--seed` flag can be used to pin the random split.

## Files

| file | purpose |
|---|---|
| `data.csv` | synthetic dataset (committed) |
| `model.py` | feature selection, scaling, split, training and evaluation |
| `run_experiment.py` | CLI entry point: reads `data.csv`, writes `metrics.json` |
| `metrics.json` | last recorded test-split metrics |
| `make_figures.py` | regenerates the PNG figures |
| `make_report.py` | regenerates `report.html` |
| `make_paper_pdf.py` | regenerates `paper.pdf` from `paper.md` |
| `paper.md` / `paper.pdf` | short paper-style write-up |
| `figures/` | performance and confusion charts |
| `report.html` | offline report with tables and figures |
| `modeling-run.json` | machine-readable run command and metrics file |
