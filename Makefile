# ═══════════════════════════════════════════════════════════════════════════
# OpenRig (cerebral-work fork) — estate verification Makefile
# Mandatory host ceres rule: all cargo invocations enforce `-j 2`.
# ═══════════════════════════════════════════════════════════════════════════

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

CARGO ?= cargo
JOBS ?= 2
CARGO_JOBS ?= -j $(JOBS)

.PHONY: help xwork check hygiene break-check spec-check projectfile-check stages-check \
	branch-hygiene stack fmt fmt-check clippy test clean

##@ General

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Estate xwork & verification pipeline

xwork: ## Run the lowered projectfile.yaml CI DAG via cargo xwork (BLAKE3 CAS cached)
	$(CARGO) xwork

check: ## Run all gates (xtask governance + cargo + the repo's npm gates)
	$(CARGO) xtask check

hygiene: ## Run fast zero-compile governance gates
	$(CARGO) xtask hygiene

break-check: ## Run hygiene gates with falsification self-tests (broken inputs must fail)
	$(CARGO) xtask hygiene --break-check

spec-check: ## Validate .lean-spec, .ears-spec and specs/NNNN-*.md
	$(CARGO) xtask spec-check

projectfile-check: ## Validate projectfile.yaml identity, repositories and version
	$(CARGO) xtask projectfile-check

stages-check: ## Verify xtask/src/stages.rs matches projectfile.yaml org.projectfile.ci.nodes
	$(CARGO) xtask stages-check

branch-hygiene: ## Verify the current branch fits the fork branch model
	$(CARGO) xtask branch-hygiene

stack: ## Show stacked-branch / GitButler status (read-only)
	$(CARGO) xtask stack status

##@ xtask crate (`-j $(JOBS)` enforced)

fmt: ## Format the xtask crate
	$(CARGO) fmt --all

fmt-check: ## Check xtask formatting
	$(CARGO) fmt --all -- --check

clippy: ## Run Clippy with -D warnings on xtask
	$(CARGO) clippy $(CARGO_JOBS) -p xtask --all-targets -- -D warnings

test: ## Run xtask unit tests
	$(CARGO) test $(CARGO_JOBS) -p xtask

clean: ## Remove Cargo build artifacts and xwork checkpoints
	$(CARGO) clean
