using Workerd = import "../node_modules/workerd/workerd.capnp";

const unitTests :Workerd.Config = (
  services = [(
    name = "accounts-request-compatibility",
    worker = (
      modules = [(name = "test", esModule = embed "accounts-runtime.mjs")],
      compatibilityDate = "2026-07-30",
      compatibilityFlags = ["global_fetch_strictly_public"],
    ),
  )],
);
