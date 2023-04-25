import dataclasses


@dataclasses.dataclass
class Repository:
    """Represents a repository in GitHub."""

    organization: str
    name: str

    def __str__(self, /) -> str:
        """Formats the repository with under its organization's namespace."""
        return f'{self.organization}/{self.name}'
