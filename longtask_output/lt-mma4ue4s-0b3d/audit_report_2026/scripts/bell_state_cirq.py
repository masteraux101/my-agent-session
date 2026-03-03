import cirq

def generate_bell_state():
    # Define two qubits
    q0 = cirq.GridQubit(0, 0)
    q1 = cirq.GridQubit(0, 1)
    
    # Create a circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    print("--- Cirq Bell State Circuit ---")
    print(circuit)
    
    # Simulate the circuit
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1024)
    
    print("\nExecution Results (Histogram):")
    print(result.histogram(key='result'))

if __name__ == "__main__":
    try:
        generate_bell_state()
    except Exception as e:
        print(f"ERROR: {e}")
