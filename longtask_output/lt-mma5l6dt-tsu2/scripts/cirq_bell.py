"""
Bell State Generation - Cirq Implementation (2026 Standard)
"""
import cirq

def create_bell_state():
    # Define qubits
    q0, q1 = cirq.LineQubit.range(2)
    
    # Create circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    print("--- Cirq Circuit ---")
    print(circuit)
    
    # Simulate
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1000)
    
    # Print results
    print("\nResults:")
    print(result.histogram(key='result'))

if __name__ == "__main__":
    create_bell_state()
