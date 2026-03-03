namespace BellStateAudit {
    open Microsoft.Quantum.Diagnostics;
    open Microsoft.Quantum.Measurement;
    open Microsoft.Quantum.Intrinsic;
    open Microsoft.Quantum.Canon;

    @EntryPoint()
    operation GenerateBellState() : Result[] {
        use (q0, q1) = (Qubit(), Qubit());
        
        H(q0);
        CNOT(q0, q1);
        
        // Dump machine state to see the entanglement
        DumpMachine();
        
        let m0 = M(q0);
        let m1 = M(q1);
        
        Reset(q0);
        Reset(q1);
        
        return [m0, m1];
    }
}
