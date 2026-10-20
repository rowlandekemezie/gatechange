DROP TABLE enrichment_model_calls;

CREATE TABLE enrichment_neurons (
  day INTEGER PRIMARY KEY NOT NULL,
  claimed INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
