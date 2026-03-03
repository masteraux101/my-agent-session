import cirq

def create_bell_state():
    # Create two qubits
    q0 = cirq.GridQubit(0, 0)
    q1 = cirq.GridQubit(0, 1)
    
    # Create a circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    # Simulate the circuit
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1024)
    
    # Get counts
    counts = result.histogram(key='result')
    return counts

if __name__ == "__main__":
    print("Running Cirq Bell State...")
    try:
        counts = create_bell_state()
        print(f"Results: {counts}")
    except Exception as e:
        print(f"Error running Cirq: {e}")
