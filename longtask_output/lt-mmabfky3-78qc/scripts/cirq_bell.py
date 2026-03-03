import cirq

def generate_bell_state():
    # Create qubits
    q0 = cirq.GridQubit(0, 0)
    q1 = cirq.GridQubit(0, 1)
    
    # Create circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    # Simulate
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=100)
    return result

if __name__ == "__main__":
    try:
        print("Running Cirq Bell State...")
        res = generate_bell_state()
        print(f"Results: {res.histogram(key='result')}")
    except Exception as e:
        print(f"Cirq Error: {e}")
