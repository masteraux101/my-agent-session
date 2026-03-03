import qsharp

# Define the Q# code as a string (Modern QDK style)
qsharp_code = """
namespace BellState {
    open Microsoft.Quantum.Diagnostics;
    open Microsoft.Quantum.Measurement;

    operation CreateBellState() : (Result, Result) {
        use (q0, q1) = (Qubit(), Qubit());
        H(q0);
        CNOT(q0, q1);
        let res = (M(q0), M(q1));
        Reset(q0);
        Reset(q1);
        return res;
    }
}
"""

# In Modern QDK, we can compile and run directly
qsharp.compile(qsharp_code)
results = []
for _ in range(100):
    res = qsharp.eval("BellState.CreateBellState()")
    results.append(str(res))

print(f"Q# Bell State Sample Results: {results[:5]} ...")
