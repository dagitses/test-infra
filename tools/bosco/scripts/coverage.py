import boscoci

boscoci.main(
    commands=[
        ['coverage', 'run', '--module', 'pytest'],
        ['coverage', 'report'],
    ],
    extra_packages=['.', 'coverage[toml]==7.2.3', 'pytest==7.3.1'],
)
