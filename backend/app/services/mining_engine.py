"""
Mining engine that orchestrates all process mining services.
Provides a unified interface for loading event logs and running analyses.
"""

import logging
from typing import Optional

import pandas as pd

from app.services.ingestion import (
    IngestionService,
    CASE_COL,
    ACTIVITY_COL,
    TIMESTAMP_COL,
    RESOURCE_COL,
    COST_COL,
)
from app.services.discovery import DiscoveryService
from app.services.conformance import ConformanceService
from app.services.bottleneck import BottleneckService
from app.services.queue_mining import QueueMiningService
from app.services.variant_analysis import VariantAnalysisService
from app.services.root_cause import RootCauseService
from app.services.statistics import StatisticsService
from app.services.drift import DriftDetector
from app.services.mining import advanced_discovery as _advanced_discovery
from app.services.mining import case_explorer as _case_explorer
from app.services.mining import discovery_views as _discovery_views
from app.services.mining import formal_methods as _formal_methods
from app.services.mining import insights as _insights
from app.services.mining import org_mining as _org_mining
from app.services.mining import performance as _performance
from app.services.mining import simulation as _simulation

logger = logging.getLogger(__name__)


class MiningEngine:
    """
    Orchestration engine for all process mining services.

    Initializes all service instances and provides delegate methods for
    loading event logs, running discovery, conformance checking, bottleneck
    analysis, variant analysis, root cause analysis, and computing statistics.
    """

    def __init__(self):
        self.ingestion_service = IngestionService()
        self.discovery_service = DiscoveryService()
        self.conformance_service = ConformanceService()
        self.bottleneck_service = BottleneckService()
        self.queue_mining_service = QueueMiningService()
        self.variant_service = VariantAnalysisService()
        self.root_cause_service = RootCauseService()
        self.statistics_service = StatisticsService()
        self.drift_detector = DriftDetector()

    def load_event_log(
        self,
        file_path: str,
        case_id_col: str,
        activity_col: str,
        timestamp_col: str,
        resource_col: str = None,
        cost_col: str = None,
    ) -> pd.DataFrame:
        """
        Load and normalize an event log file into a standardized DataFrame.

        Delegates to IngestionService.load_event_log.
        """
        return self.ingestion_service.load_event_log(
            file_path=file_path,
            case_id_col=case_id_col,
            activity_col=activity_col,
            timestamp_col=timestamp_col,
            resource_col=resource_col,
            cost_col=cost_col,
        )

    def run_discovery(
        self, df: pd.DataFrame, algorithm: str = "dfg", parameters: dict = None
    ) -> dict:
        """
        Run process discovery using the specified algorithm.

        Delegates to DiscoveryService.discover.
        """
        return self.discovery_service.discover(
            df=df, algorithm=algorithm, parameters=parameters
        )

    def run_conformance(
        self,
        df: pd.DataFrame,
        reference_model: dict = None,
        method: str = "token_replay",
    ) -> dict:
        """
        Run conformance checking against a reference model.

        Args:
            df: Event log DataFrame (pm4py column names).
            reference_model: Optional pre-discovered model. If absent, one
                is discovered from the log using the Inductive Miner.
            method: Conformance method — one of:
                - "token_replay" (default): classic Petri-net token replay
                - "alignment": alignment-based conformance via pm4py
                  (more accurate on skipped activities / invisible
                  transitions; strictly more expensive)
                - "decomposed": decomposed alignment-based conformance,
                  splits the net into SESE regions for tractable scaling
                  on large logs (>50k events)
                - "footprints": footprint-based conformance (cheapest,
                  structural-only)
                - "auto": choose automatically based on log size —
                  alignment for small logs, decomposed for large ones
        """
        # Auto-mode routing: decomposed alignment scales to millions of
        # events where plain alignment OOMs around ~100k. The cost model
        # is approximate — full alignment is exact, decomposed is an
        # upper bound but 10-100x faster on wide nets.
        if method == "auto":
            event_count = len(df)
            if event_count >= 50_000:
                method = "decomposed"
            else:
                method = "alignment"

        return self.conformance_service.check_conformance(
            df=df, reference_model=reference_model, method=method,
        )

    def compute_stochastic_conformance(
        self,
        df: pd.DataFrame,
        reference_model: dict = None,
    ) -> dict:
        """Stochastic conformance via Earth Mover's Distance (EMD).

        Delegates to ConformanceService.compute_stochastic_conformance.
        See that method for the full docstring and paper references.

        Returns a dict with emd_distance, stochastic_fitness,
        top_deviating_variants, severity_breakdown, log_variants_count,
        and model_traces_sampled.
        """
        return self.conformance_service.compute_stochastic_conformance(
            df=df, reference_model=reference_model,
        )

    def run_bottleneck_analysis(self, df: pd.DataFrame) -> dict:
        """
        Run bottleneck analysis to identify slow activities and transitions.

        Delegates to BottleneckService.analyze_bottlenecks.
        """
        return self.bottleneck_service.analyze_bottlenecks(df=df)

    def analyze_queue(self, df: pd.DataFrame) -> dict:
        """
        Run M/M/c queue mining to estimate resource contention and wait-time
        decomposition per activity.

        Delegates to QueueMiningService.analyze (Senderovich et al., 2015).
        """
        return self.queue_mining_service.analyze(df=df)

    def run_variant_analysis(self, df: pd.DataFrame) -> dict:
        """
        Run variant analysis to identify unique process paths.

        Delegates to VariantAnalysisService.analyze_variants.
        """
        return self.variant_service.analyze_variants(df=df)

    def run_root_cause_analysis(self, df: pd.DataFrame) -> dict:
        """
        Run root cause analysis to identify attributes impacting performance.

        Delegates to RootCauseService.analyze_root_causes.
        """
        return self.root_cause_service.analyze_root_causes(df=df)

    def compute_statistics(self, df: pd.DataFrame) -> dict:
        """
        Compute comprehensive process statistics.

        Delegates to StatisticsService.compute_statistics.
        """
        return self.statistics_service.compute_statistics(df=df)

    def get_cases(self, df: pd.DataFrame, limit: int = 1000) -> dict:
        """Return summary information for each case in the event log.

        Implementation in app.services.mining.case_explorer.
        """
        return _case_explorer.get_cases(df, limit)

    def get_case_detail(self, df: pd.DataFrame, case_id: str) -> Optional[dict]:
        """Return all events for a specific case, including duration to the next

        Implementation in app.services.mining.case_explorer.
        """
        return _case_explorer.get_case_detail(df, case_id)

    def get_edge_stats(
        self,
        df: pd.DataFrame,
        source: str,
        target: str,
        bins: int = 20,
    ) -> dict:
        """Return statistics for a single (source → target) transition.

        Implementation in app.services.mining.discovery_views.
        """
        return _discovery_views.get_edge_stats(df, source, target, bins)

    def get_timeline(self, df: pd.DataFrame, limit: int = 5000) -> dict:
        """Return events sorted by timestamp for animation replay, including the

        Implementation in app.services.mining.case_explorer.
        """
        return _case_explorer.get_timeline(df, limit)

    def get_dotted_chart(self, df: pd.DataFrame, limit: int = 10000) -> dict:
        """Return event data for a dotted chart visualization.

        Implementation in app.services.mining.case_explorer.
        """
        return _case_explorer.get_dotted_chart(df, limit)

    def get_social_network(self, df: pd.DataFrame) -> dict:
        """Build a handover-of-work social network between resources.

        Implementation in app.services.mining.org_mining.
        """
        return _org_mining.get_social_network(df)

    def compare_process(
        self,
        df: pd.DataFrame,
        split_attribute: str,
        split_value_a: str,
        split_value_b: str,
    ) -> dict:
        """Compare two subsets of the event log split by an attribute column.

        Implementation in app.services.mining.discovery_views.
        """
        return _discovery_views.compare_process(self, df, split_attribute, split_value_a, split_value_b)

    def get_rework(self, df: pd.DataFrame) -> dict:
        """Detect rework (activity repeated within the same case) and self-loops

        Implementation in app.services.mining.discovery_views.
        """
        return _discovery_views.get_rework(df)

    def get_activity_detail(self, df: pd.DataFrame, activity_name: str) -> dict:
        """Return detailed statistics for a single activity.

        Implementation in app.services.mining.case_explorer.
        """
        return _case_explorer.get_activity_detail(self, df, activity_name)

    def run_simulation(
        self, df: pd.DataFrame, modifications: list[dict], num_traces: int = 500
    ) -> dict:
        """Run a what-if process simulation.

        Implementation in app.services.mining.simulation.
        """
        return _simulation.run_simulation(df, modifications, num_traces)




    def generate_summary(self, df: pd.DataFrame) -> dict:
        """Generate a comprehensive process summary by running DFG discovery,

        Implementation in app.services.mining.simulation.
        """
        return _simulation.generate_summary(self, df)


    # pm4py column key mappings used by the new advanced endpoints
    _PM4PY_KEYS = {
        "case_id_key": "case:concept:name",
        "activity_key": "concept:name",
        "timestamp_key": "time:timestamp",
    }
    _RESOURCE_KEY = "org:resource"

    def get_performance_dfg(self, df: pd.DataFrame) -> dict:
        """Discover a performance DFG where edge weights are average transition

        Implementation in app.services.mining.discovery_views.
        """
        return _discovery_views.get_performance_dfg(df)

    def get_efg(self, df: pd.DataFrame) -> dict:
        """Discover the Eventually-Follows Graph: all pairs (a, b) where a

        Implementation in app.services.mining.discovery_views.
        """
        return _discovery_views.get_efg(df)

    def get_temporal_profile(self, df: pd.DataFrame) -> dict:
        """Discover a temporal profile (mean/stdev of time between every

        Implementation in app.services.mining.performance.
        """
        return _performance.get_temporal_profile(df)

    def get_batches(self, df: pd.DataFrame) -> dict:
        """Detect batch execution patterns (activities performed in batches by a

        Implementation in app.services.mining.performance.
        """
        return _performance.get_batches(df)

    def get_case_overlap(self, df: pd.DataFrame) -> dict:
        """Compute the number of concurrently active cases at each point in time.

        Implementation in app.services.mining.performance.
        """
        return _performance.get_case_overlap(df)

    def get_org_roles(self, df: pd.DataFrame) -> dict:
        """Discover organizational roles: groups of resources that share similar

        Implementation in app.services.mining.org_mining.
        """
        return _org_mining.get_org_roles(df)

    def get_sna(self, df: pd.DataFrame, network_type: str = "handover") -> dict:
        """Compute a Social Network Analysis matrix for the given network type.

        Implementation in app.services.mining.org_mining.
        """
        return _org_mining.get_sna(df, network_type)

    def cluster_log(self, df: pd.DataFrame, n_clusters: int = 3) -> dict:
        """Cluster the event log into n_clusters groups using KMeans on pm4py features.

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.cluster_log(df, n_clusters)

    def cluster_log_dbscan(self, df: pd.DataFrame, eps: float = 0.5, min_samples: int = 5) -> dict:
        """Density-based trace clustering (DBSCAN on PCA-reduced features).

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.cluster_log_dbscan(df, eps, min_samples)

    def run_discovery_ilp(self, df: pd.DataFrame) -> dict:
        """Discover a Petri net using ILP Miner (integer linear programming).

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.run_discovery_ilp(df)

    def discover_decision_rules(self, df: pd.DataFrame) -> dict:
        """Decision mining — find which case attributes predict branch choices.

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.discover_decision_rules(df)

    def discover_staff_assignment(self, df: pd.DataFrame) -> dict:
        """Staff assignment mining — who does what, with confidence.

        Implementation in app.services.mining.org_mining.
        """
        return _org_mining.discover_staff_assignment(df)

    def digital_twin_parameters(self, df: pd.DataFrame) -> dict:
        """Auto-discover resource-aware simulation parameters from a log.

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.digital_twin_parameters(df)

    def discover_dcr_rules(self, df: pd.DataFrame) -> dict:
        """Discover a minimal DCR graph (conditions + responses) from the log.

        Implementation in app.services.mining.formal_methods.
        """
        return _formal_methods.discover_dcr_rules(df)

    def check_ltl(self, df: pd.DataFrame, formula: str) -> dict:
        """Evaluate a small LTL-f dialect against every case in the log.

        Implementation in app.services.mining.formal_methods.
        """
        return _formal_methods.check_ltl(df, formula)


    def run_correlation_mining(self, df: pd.DataFrame) -> dict:
        """Correlation-miner discovery for logs without explicit case IDs.

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.run_correlation_mining(df)

    def get_log_skeleton(self, df: pd.DataFrame) -> dict:
        """Discover the log skeleton — six families of declarative constraints

        Implementation in app.services.mining.formal_methods.
        """
        return _formal_methods.get_log_skeleton(df)

    def get_declare(self, df: pd.DataFrame, support_threshold: float = 0.7) -> dict:
        """Discover DECLARE constraints from the event log.

        Implementation in app.services.mining.formal_methods.
        """
        return _formal_methods.get_declare(df, support_threshold)

    def check_four_eyes(
        self, df: pd.DataFrame, activity1: str, activity2: str
    ) -> dict:
        """Find cases that violate the four-eyes principle: cases where the same

        Implementation in app.services.mining.org_mining.
        """
        return _org_mining.check_four_eyes(df, activity1, activity2)

    def get_performance_spectrum(self, df: pd.DataFrame, limit: int = 100) -> dict:
        """Return per-case activity timelines for performance spectrum visualization.

        Implementation in app.services.mining.discovery_views.
        """
        return _discovery_views.get_performance_spectrum(df, limit)

    def get_features(self, df: pd.DataFrame) -> dict:
        """Extract a feature DataFrame from the event log (one row per case).

        Implementation in app.services.mining.advanced_discovery.
        """
        return _advanced_discovery.get_features(df)

    def generate_insights(self, df: pd.DataFrame) -> dict:
        """Run multiple analyses on the DataFrame and generate plain-language insights.

        Implementation in app.services.mining.insights.
        """
        return _insights.generate_insights(self, df)

    def detect_drifts(
        self,
        df: pd.DataFrame,
        window: str = "auto",
        sensitivity: float = 0.15,
    ) -> dict:
        """
        Detect concept drift by sliding a window over the log and computing
        Jensen-Shannon divergence between consecutive transition distributions.

        Delegates to DriftDetector.detect_drifts.

        Args:
            df:          Event log DataFrame (pm4py column names).
            window:      "auto", "day", "week", "month", or "<N>cases".
            sensitivity: JSD threshold above which a transition is a drift.

        Returns:
            dict matching DriftResponse schema.
        """
        return self.drift_detector.detect_drifts(
            df=df, window=window, sensitivity=sensitivity
        )

    # ── DES delegates ──────────────────────────────────────────────────────────

    def mine_des_parameters(self, df: pd.DataFrame) -> dict:
        """
        Delegate to DESSimulator.mine_simulation_parameters.
        Extracts arrival distribution, per-activity duration stats,
        gateway probabilities, resource pools and hourly calendar.
        """
        from app.services.simulation_des import DESSimulator
        return DESSimulator().mine_simulation_parameters(df)

    def run_des_simulation(
        self,
        df: pd.DataFrame,
        scenario: dict,
        runs: int = 5,
        max_cases: int = 1000,
    ) -> dict:
        """
        Mine parameters from *df* and run DES with the given what-if scenario.
        Returns summary + baseline + delta dict as defined by DESSimulator.simulate.
        """
        from app.services.simulation_des import DESSimulator
        sim = DESSimulator()
        params = sim.mine_simulation_parameters(df)
        return sim.simulate(params, scenario, runs=runs, max_cases=max_cases)


# Module-level singleton instance
mining_engine = MiningEngine()
