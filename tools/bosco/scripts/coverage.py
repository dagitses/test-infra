import boscoci

boscoci.main(
    commands=[
        # We aren't interested in the test output, since we expect
        # that to run in the pytest job. Hide it in a group so we see
        # the coverage report front and center.
        ['echo', '::group::run tests']
        ['coverage', 'run', '--module', 'pytest'],
        ['echo', '::endgroup::']

        ['coverage', 'report'],
    ],
    extra_packages=['.', 'coverage[toml]==7.2.3', 'pytest==7.3.1'],
)
