"""
Bell State Generation in Cirq
Generates the state: (|00> + |11>) / sqrt(2)
"""
import cirq

def run_bell_state():
    # Define qubits
    q0, q1 = cirq.LineQubit.range(2)
    
    # Create the circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    # Simulate the circuit
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1024)
    
    # Process results
    counts = result.histogram(key='result')
    print("Cirq Bell State Execution Results (Decimal representation):")
    print(counts)

if __name__ == "__main__":
    run_bell_state()
