namespace BellState {
    open Microsoft.Quantum.Diagnostics;
    open Microsoft.Quantum.Intrinsic;
    open Microsoft.Quantum.Measurement;

    @EntryPoint()
    operation GenerateBellState() : (Result, Result) {
        use (q0, q1) = (Qubit(), Qubit());
        
        H(q0);
        CNOT(q0, q1);
        
        let res0 = M(q0);
        let res1 = M(q1);
        
        Reset(q0);
        Reset(q1);
        
        return (res0, res1);
    }
}
