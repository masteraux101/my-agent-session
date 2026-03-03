namespace BellState {
    open Microsoft.Quantum.Diagnostics;
    open Microsoft.Quantum.Measurement;
    open Microsoft.Quantum.Intrinsic;
    open Microsoft.Quantum.Canon;

    @EntryPoint()
    operation GenerateBellState() : Result[] {
        use (q0, q1) = (Qubit(), Qubit());
        
        H(q0);
        CNOT(q0, q1);
        
        let results = [M(q0), M(q1)];
        
        ResetAll([q0, q1]);
        return results;
    }
}
