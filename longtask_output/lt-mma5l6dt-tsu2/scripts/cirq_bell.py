"""
Cirq Bell State Generation
"""
import cirq

def create_bell_state():
    # Define qubits
    q0 = cirq.GridQubit(0, 0)
    q1 = cirq.GridQubit(0, 1)
    
    # Create circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    print("--- Cirq Bell State Circuit ---")
    print(circuit)
    
    # Simulate
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1000)
    
    print("\nResults Summary:")
    print(result.histogram(key='result'))

if __name__ == "__main__":
    create_bell_state()
