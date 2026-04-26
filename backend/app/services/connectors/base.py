"""
Abstract base class for data source connectors.
All connectors (CSV, XES, Database, etc.) must implement this interface.
"""

from abc import ABC, abstractmethod


class BaseConnector(ABC):
    """Abstract base connector for data source integrations."""

    @abstractmethod
    async def test_connection(self, config: dict) -> dict:
        """
        Test if the connection works with the given configuration.

        Args:
            config: Connector-specific configuration dict.

        Returns:
            {"success": bool, "message": str}
        """
        pass

    @abstractmethod
    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Fetch data from the source and save it to a local file.

        Args:
            config: Connector-specific configuration dict.
            column_mapping: Mapping of logical column names to source column names.

        Returns:
            file_path: Path to the saved file on disk.
        """
        pass

    def get_default_column_mapping(self, config: dict) -> dict | None:
        """
        Return a pre-filled column mapping for connectors with known schemas.
        Returns None if the user must specify mapping manually (e.g., generic DB/API).
        """
        return None

    @abstractmethod
    async def get_schema(self, config: dict) -> dict:
        """
        Get the available schema (tables/columns) from the data source.

        Args:
            config: Connector-specific configuration dict.

        Returns:
            {"tables": [{"name": str, "columns": [{"name": str, "type": str}, ...]}, ...]}
        """
        pass
