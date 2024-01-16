## UDS Operator

The UDS Operator manages the lifecycle of UDS Package CRs and their corresponding resources (e.g. NetworkPolicies, Istio VirtualServices, etc.). The operator uses [Pepr](https://pepr.dev) to bind the watch operations to the enqueue and reconciler. The operator is responsible for:

- enabling Istio sidecar injection in namespaces where the CR is deployed
- establishing default-deny ingress/egress network policies 
- creating a layered allow-list based approach on top of the default deny network policies including some basic defaults such as Istio requirements and DNS egress
- providing targeted remote endpoints network policies such as `KubeAPI` and `CloudMetadata` to make policies more DRY and provide dynamic bindings where a static definition is not possible
- creating Istio Virtual Services & related ingress gateway network policies

### Key Files and Folders

```bash
.
├── controllers          # Core business logic called by the reconciler
│   ├── istio            # Manages Istio VirtualServices and sidecar injection for UDS Packages/Namespace
│   └── network          # Manages default and generated NetworkPolicies for UDS Packages/Namespace
├── crd
│   ├── generated        # Type files generated by `uds run -f src/pepr/tasks.yaml gen-crds`
│   ├── sources          # CRD source files
│   ├── register.ts      # Registers the UDS Package CRD with the Kubernetes API
│   └── validator.ts     # Validates UDS Package CRs with Pepr
├── enqueue.ts           # Serializes UDS Package CRs for processing by the reconciler
├── index.ts             # Entrypoint for the UDS Operator
└── reconciler.ts        # Reconciles UDS Package CRs via the controllers
```


### Flow

The UDS Operator leverages a Pepr Watch. The following diagram shows the flow of the UDS Operator:

```mermaid
graph TD
    A["New UDS Package (pkg) received from Pepr"] -->|Watch Action| B["Queue: queue.enqueue(pkg)"]
    B --> C{"Check if pkg is next on Queue"}
    C -->|Yes| D["queue.dequeue()"]
    C -->|No| E["Wait in Queue"]
    D --> F["reconciler(pkg)"]
    F --> G{"Check if pkg is pending or on current generation"}
    G -->|Yes| H["Log: Skipping pkg"]
    G -->|No| I["Update pkg status to Phase.Pending"]
    I --> J{"Check if Istio is installed"}
    J -->|Yes| K["Add injection label, process expose CRs for Virtual Services"]
    J -->|No| L["Skip Virtual Service Creation"]
    K --> M["Create default network policies in namespace"]
    L --> M
    M --> N["Process allow CRs for network policies"]
    N --> O["Process expose CRs for network policies for VS/Istio ingress routes"]
    O --> P["Update status: Phase.Ready, observedGeneration, etc."]
    H --> Q["End of process"]
    P --> Q
```