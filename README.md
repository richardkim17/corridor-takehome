# Client Context Ingestion System

## About Corridor

Corridor is an AI-native health insurance brokerage helping small businesses get better benefits for their employees. Health insurance brokerage is a $100B+ gateway to healthcare that still runs on decades-old technology, leaving small businesses especially underserved. We combine expert brokers with frontier AI agents to deliver a level of service that was never economically possible before.

Our Engineering, Product & Design team builds the agentic systems that analyze markets and recommend coverage, the infrastructure connecting employers, carriers, and employees, and the service layer that supports clients year-round. This exercise reflects a core challenge in that work: keeping agents grounded in current, trustworthy client context as it evolves.

## Problem

Build a system that turns meeting transcripts into structured client context. The context must be correct, auditable, fault-tolerant, and safe to read concurrently. Correctness is the primary evaluation criterion.

## Inputs

The system ingests meeting transcripts (see [Stub API reference](api.md)).

## Execution Model

For now, the ingestion pipeline should run as a cron job (every 1 day). Each run should poll the transcript API, process any new or changed meetings, and update the client context. The same pipeline should also be runnable on demand for testing and the freshness demo below.

## Extraction

From each transcript, the system should extract:

1. The client the meeting is about (used as the key for all downstream storage).
2. A configurable set of facts about that client. Examples:
  - Number of employees
  - Benefit cycle start date
  - Preferred plan type (for example, HMO, PPO, or HDHP)
  - Employer budget per employee per month
  - Plans and per-employee monthly pricing found by the incumbent broker

The set of facts must be configurable - new fact types should be addable without reworking the pipeline.

## Storage: the Client Context

Extracted facts are written into a per-client "client context." This context is the source of truth for downstream consumers.

The implementation must use a database for persistent storage. The database choice, schema, and transaction strategy are implementation decisions, but the result must support the correctness, auditability, fault-tolerance, and concurrent-read guarantees described below.

The client context must satisfy three properties:

### 1. Evolves over time

A client's facts change (headcount grows, cycle dates shift, plan preferences change, budgets increase, and quoted prices are revised). The context must support updates, not just initial writes.

### 2. Auditable

For every fact, we need to answer:

- Provenance: what transcript (or other source) originally produced this value?
- History: if the fact has been updated, what were the prior values and where did each come from?



### 3. Consistent to read

The system must guarantee that a reader never observes a partially-updated or inconsistent view of the context.

## MCP Server

Build an MCP server that exposes the persisted client context through a read-only tool. The tool must:

- Look up a client and return its current facts.
- Include enough provenance and version information for a caller to understand where the current values came from and whether the context has changed.
- Return clear errors when a client cannot be found or a request is invalid.
- Read from the database as the source of truth rather than maintaining a separate in-memory copy of the context.

Document the tool's contract, including its inputs, outputs, and error behavior.

## Agent Integration and Freshness Demo

Connect the MCP server to either a Claude or ChatGPT agent. Submit a demo video showing that the agent can use fresh client context as it evolves over time:

1. In a single conversation thread, ask the agent about a client and show its answer based on the current context.
2. Ingest a new or changed transcript that updates that client's context.
3. Minutes later, ask about the client again in the same thread.
4. Show that the agent performs a new MCP read and answers with the latest context without repeating, mixing up, or otherwise confusing it with the earlier value.

Only one provider integration is required. Written setup or reproduction instructions for the integration are not required; the demo video is the required evidence.

For the video, you can have a separate trigger that mocks the cron job so that you can ingest new data more frequently (e.g., every 1-2 mins).

## Fault Tolerance

The pipeline spans external APIs and persistent storage - any stage can fail. The system must tolerate these failures without losing data or corrupting the client context.

## Evaluation

Correctness - extracting the right facts about the right client, and maintaining the audit, consistency, and fault-tolerance guarantees above - is the most important criterion.

We will also evaluate the MCP tool design, successful integration with Claude or ChatGPT, and how clearly the demo video establishes that the agent retrieves and uses fresh context over time within the same thread.

Some parts of the system are intentionally open-ended. You may make reasonable assumptions about ambiguous requirements, but should be prepared to explain those assumptions and the tradeoffs behind them.