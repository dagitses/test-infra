import boscoci

boscoci.main(
    commands=[['mypy', '.']],
    extra_packages=['mypy==1.2.0', 'pytest==7.3.1'],
)
